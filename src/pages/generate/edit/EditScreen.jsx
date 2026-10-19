import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import HighwayPreview from "../../../highway/HighwayPreview.jsx";
import { I } from "../../../icons.jsx";
import { DIFF } from "../../../data/difficultyMetadata.js";
import EditInspector from "./EditInspector.jsx";
import EditOverview from "./EditOverview.jsx";
import PianoRollEditor from "./PianoRollEditor.jsx";
import {
  barEndTick,
  barIndexAt,
  buildBarGrid,
  noteIdsInRegions,
  normalizeRegions,
  redoLabel,
  regionsCover,
  sectionsFromDoc,
  selectionLabel,
  subtractSpan,
} from "./editRegions.js";
import { startRedo } from "./inpaintService.js";

// The full-screen chart editor. Preview on top with the panel beside it; the
// transport + song strip and the full-width piano roll below.
//
// One selection drives everything: the notes you pick, plus the whole bars
// under them (or whole sections / bar ranges picked from the strip or the
// ruler). Note actions apply to the notes; Redo applies to the bars. Every
// change autosaves into the edited draft take; the source take is never
// touched.

const SNAP_OPTIONS = ["off", "1/4", "1/8", "1/12", "1/16", "1/24", "1/32"];

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function EditScreen({ project }) {
  const {
    editor,
    applyEditorChange,
    setEditorSnap,
    undoEditorChange,
    redoEditorChange,
    finishEditing,
    discardEditorDraft,
    setEditorPlayhead,
    setEditorPlaying,
    audioBuffer,
    activeVideoOffset,
    background,
    busyAction,
    statusMsg,
  } = project;
  const doc = editor.doc;
  const highwayRef = useRef(null);
  const rollApiRef = useRef(null);
  const jobRef = useRef(null);

  const [regions, setRegions] = useState([]);
  const [pending, setPending] = useState(null);
  const [knobs, setKnobs] = useState({ density: "auto", chords: "auto", movement: "auto" });
  const [loopOn, setLoopOn] = useState(false);
  const [view, setView] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const songEndTick = useMemo(() => {
    if (!doc) return 0;
    const seconds = Math.max(doc.durationSec || 0, editor.playhead.duration || 0);
    return Math.ceil(doc.tempoMap.secondsToTick(seconds));
  }, [doc, editor.playhead.duration]);
  const bars = useMemo(() => buildBarGrid(doc, songEndTick), [doc?.sync, doc?.resolution, songEndTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const sections = useMemo(() => sectionsFromDoc(doc, songEndTick, bars), [doc?.events, songEndTick, bars]); // eslint-disable-line react-hooks/exhaustive-deps
  const redos = doc?.redos || [];

  const selectedNotes = useMemo(() => {
    if (!doc || !editor.selectedNoteIds.length) return [];
    const ids = new Set(editor.selectedNoteIds);
    return doc.notes.filter((note) => ids.has(note.id));
  }, [doc, editor.selectedNoteIds]);
  // The bars a Redo would rewrite. Only picked spans count: clicking a note
  // (to stretch it, say) never turns its bars into a redo target.
  const targetRegions = regions;
  const selectionName = selectionLabel(bars, targetRegions, sections);
  // The redo whose bars are exactly the selection; its takes show in the panel.
  const selectedRedo = useMemo(() => redos.find((redo) =>
    redo.regions.length === targetRegions.length &&
    redo.regions.every((r, i) => r.startTick === targetRegions[i].startTick && r.endTick === targetRegions[i].endTick)
  ) || null, [redos, targetRegions]);

  // Loop the picked bars, or the newest redo, with a bar of run-in and run-out
  // so both seams are heard.
  const loop = useMemo(() => {
    if (!loopOn || !bars.length) return null;
    const target = targetRegions.length ? targetRegions : redos[redos.length - 1]?.regions;
    if (!target?.length) return null;
    const first = barIndexAt(bars, target[0].startTick);
    const last = barIndexAt(bars, target[target.length - 1].endTick - 1);
    return { startTick: bars[Math.max(0, first - 1)], endTick: barEndTick(bars, Math.min(bars.length - 1, last + 1)) };
  }, [loopOn, targetRegions, redos, bars]);
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const canLoop = Boolean(targetRegions.length || redos.length);

  // ---- playback ----
  useEffect(() => {
    if (!editor.seekRequest) return;
    highwayRef.current?.seek?.(editor.seekRequest.seconds);
  }, [editor.seekRequest]);

  const togglePlay = useCallback(() => {
    const preview = highwayRef.current;
    if (!preview) return;
    if (preview.isPlaying?.()) {
      preview.pause?.();
      return;
    }
    const active = loopRef.current;
    if (active && doc) {
      const tick = doc.tempoMap.secondsToTick(editor.playhead.time || 0);
      if (tick < active.startTick || tick >= active.endTick) preview.seek?.(doc.tempoMap.tickToSeconds(active.startTick));
    }
    preview.play?.();
  }, [doc, editor.playhead.time]);

  useEffect(() => {
    if (!editor.playRequest) return;
    togglePlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.playRequest]);

  const onProgress = useCallback((time, duration) => {
    setEditorPlayhead({ time, duration });
    const active = loopRef.current;
    if (!active || !doc || !highwayRef.current?.isPlaying?.()) return;
    if (time >= doc.tempoMap.tickToSeconds(active.endTick)) {
      highwayRef.current.seek(doc.tempoMap.tickToSeconds(active.startTick));
    }
  }, [doc, setEditorPlayhead]);

  const seekTick = useCallback((tick) => {
    if (!doc) return;
    highwayRef.current?.seek?.(doc.tempoMap.tickToSeconds(Math.max(0, tick)));
  }, [doc]);

  // ---- redo ----
  const runRedo = useCallback((targetRegions, { redoId = null, label }) => {
    if (!doc || pending || !targetRegions.length) return;
    const total = targetRegions.reduce((sum, r) => sum + barIndexAt(bars, r.endTick - 1) - barIndexAt(bars, r.startTick) + 1, 0);
    setPending({ regions: targetRegions, notes: [], done: 0, total, label });
    const job = startRedo({
      doc,
      bars,
      regions: targetRegions,
      knobs,
      onProgress: ({ done, notes }) => setPending((current) => (current ? { ...current, done, notes } : current)),
    });
    jobRef.current = job;
    job.promise
      .then((notes) => {
        applyEditorChange({ type: "applyRedo", redoId, regions: targetRegions, notes, label });
        // The redone bars stay selected, so Redo again tries another take.
        setRegions(targetRegions);
        applyEditorChange({ type: "select", noteIds: notes.map((note) => note.id) });
        setLoopOn(true);
        seekTick(bars[Math.max(0, barIndexAt(bars, targetRegions[0].startTick) - 1)]);
        rollApiRef.current?.scrollToTick(targetRegions[0].startTick, "start");
      })
      .catch((err) => {
        if (err?.name !== "AbortError") console.error(err);
      })
      .finally(() => {
        if (jobRef.current === job) jobRef.current = null;
        setPending(null);
      });
  }, [doc, pending, bars, knobs, applyEditorChange, seekTick]);

  useEffect(() => () => jobRef.current?.cancel(), []);

  // Redoing the exact bars of an earlier redo adds a take to it, so its
  // Original stays reachable.
  const redoSelection = () =>
    runRedo(targetRegions, { redoId: selectedRedo?.id ?? null, label: selectedRedo?.label ?? redoLabel(bars, targetRegions, sections) });
  const redoToEnd = () => {
    const start = targetRegions[0]?.startTick ?? bars[barIndexAt(bars, doc.tempoMap.secondsToTick(editor.playhead.time || 0))];
    const lastBar = barIndexAt(bars, Math.max(start, songEndTick - 1));
    const span = { startTick: start, endTick: barEndTick(bars, lastBar) };
    runRedo([span], { label: `Bar ${barIndexAt(bars, start) + 1} to the end` });
  };

  // ---- selection ----
  // Picking spans selects every note inside them too.
  const selectSpans = useCallback((next) => {
    setRegions(next);
    applyEditorChange({ type: "select", noteIds: noteIdsInRegions(doc, next) });
  }, [applyEditorChange, doc]);

  const clearAll = useCallback(() => {
    setRegions([]);
    applyEditorChange({ type: "clearSelection" });
  }, [applyEditorChange]);

  // Clicking a section selects it and moves the playhead there. Shift adds
  // it, or takes it out if it is already in the selection.
  const pickSection = (section, additive) => {
    const span = { startTick: section.startTick, endTick: section.endTick };
    const covered = regionsCover(targetRegions, span);
    if (additive) {
      selectSpans(covered ? subtractSpan(targetRegions, span) : normalizeRegions([...targetRegions, span]));
      if (covered) return;
    } else {
      selectSpans([span]);
    }
    seekTick(span.startTick);
    rollApiRef.current?.scrollToTick(span.startTick, "start");
  };

  const selectBarSpan = (span, additive) => selectSpans(additive ? normalizeRegions([...targetRegions, span]) : [span]);

  // A box drag selects the notes in the box and the whole bars it crosses.
  const boxSelect = (noteIds, span, additive) => {
    setRegions(additive ? normalizeRegions([...regions, span]) : [span]);
    applyEditorChange({ type: "select", noteIds, additive });
  };

  // ---- note actions ----
  const noteAction = useCallback((action) => {
    const ids = editor.selectedNoteIds;
    if (!ids.length || !doc) return;
    if (action === "tap") applyEditorChange({ type: "toggleTap", ids });
    else if (action === "force") applyEditorChange({ type: "toggleForce", ids });
    else if (action === "quantize") applyEditorChange({ type: "quantizeSelection", ids, snap: editor.snap === "off" ? "1/16" : editor.snap });
    else if (action === "split") applyEditorChange({ type: "splitChords", ids, snap: editor.snap });
    else if (action === "delete") applyEditorChange({ type: "deleteSelection" });
    else if (action === "starPower" || action === "solo") {
      const picked = doc.notes.filter((note) => ids.includes(note.id));
      const startTick = Math.min(...picked.map((n) => n.tick));
      const endTick = Math.max(...picked.map((n) => n.tick + Math.max(0, ...Object.values(n.sustainsByLane), 0))) + Math.round(doc.resolution / 8);
      applyEditorChange({ type: "addRange", kind: action, startTick, endTick });
    }
  }, [applyEditorChange, doc, editor.selectedNoteIds, editor.snap]);

  // ---- keyboard ----
  const keyActions = useRef({});
  keyActions.current = { togglePlay, noteAction, redoSelection, targetRegions, pending, canLoop, clearAll };
  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const a = keyActions.current;
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redoEditorChange();
        else undoEditorChange();
      } else if (mod && key === "y") {
        e.preventDefault();
        redoEditorChange();
      } else if (mod || e.altKey) {
        return;
      } else if (e.key === " ") {
        e.preventDefault();
        a.togglePlay();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        a.noteAction("delete");
      } else if (e.key === "Escape") {
        a.clearAll();
        setHelpOpen(false);
      } else if (key === "t") a.noteAction("tap");
      else if (key === "h") a.noteAction("force");
      else if (key === "s") a.noteAction("starPower");
      else if (key === "q") a.noteAction("quantize");
      else if (key === "l" && a.canLoop) setLoopOn((v) => !v);
      else if (key === "r" && a.targetRegions.length && !a.pending) a.redoSelection();
      else if (e.key === "=" || e.key === "+") rollApiRef.current?.zoom(1.25);
      else if (e.key === "-") rollApiRef.current?.zoom(0.8);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyEditorChange, redoEditorChange, undoEditorChange]);

  useEffect(() => {
    if (!menuOpen && !helpOpen) return undefined;
    const close = () => {
      setMenuOpen(false);
      setHelpOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen, helpOpen]);

  if (!doc) return null;

  const name = editor.draftVersion?.name || editor.sourceVersion?.name || "Editing";
  const diff = DIFF[doc.difficulty] || DIFF.expert;
  const saveLabel = editor.dirty ? "Saving…" : editor.savedAt ? "Saved" : "";
  const playheadTick = doc.tempoMap.secondsToTick(editor.playhead.time || 0);

  return (
    <div className="edit-screen">
      <header className="edit-head">
        <button className="edit-back" onClick={finishEditing} title="Back to the takes">
          <I.back /> Takes
        </button>
        <div className="edit-title">
          <span className="edit-badge">{editor.draftVersion?.badge || "E"}</span>
          <b title={name}>{name}</b>
          <span className={`edit-diff tone-${diff.color}`}>{diff?.name || doc.difficulty}</span>
          {editor.sourceVersion && <span className="edit-from">from {editor.sourceVersion.name}</span>}
          {saveLabel && <span className={"edit-save" + (editor.dirty ? " busy" : "")}>{saveLabel}</span>}
        </div>
        <div className="edit-head-actions">
          <button className="edit-icon-btn" onClick={undoEditorChange} disabled={!editor.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><I.undo /></button>
          <button className="edit-icon-btn" onClick={redoEditorChange} disabled={!editor.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><I.redo /></button>
          <div className="edit-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button className="edit-icon-btn" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen} aria-label="Mouse and keys" title="Mouse and keys"><I.info /></button>
            {helpOpen && <EditHelp />}
          </div>
          <div className="edit-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button className="edit-icon-btn" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen} aria-label="More"><I.kebab /></button>
            {menuOpen && (
              <div className="edit-menu">
                <button onClick={() => { setMenuOpen(false); void discardEditorDraft(); }} disabled={busyAction === "removing"}>
                  <I.trash /> Delete this edit
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="edit-stage">
        <HighwayPreview
          ref={highwayRef}
          track={editor.previewTrack || null}
          audioBuffer={audioBuffer}
          videoOffset={activeVideoOffset}
          background={background}
          className="edit-preview"
          hideTransport
          onProgress={onProgress}
          onPlayingChange={setEditorPlaying}
        />
      </div>

      <EditInspector
        doc={doc}
        bars={bars}
        regions={targetRegions}
        selectionName={selectionName}
        selectedRedo={selectedRedo}
        selectedNotes={selectedNotes}
        pending={pending}
        knobs={knobs}
        onKnob={(key, value) => setKnobs((current) => ({ ...current, [key]: value }))}
        onRedo={redoSelection}
        onRedoToEnd={redoToEnd}
        onCancelRedo={() => jobRef.current?.cancel()}
        onNoteAction={noteAction}
        onFocusRedo={(redo) => { selectSpans(redo.regions); rollApiRef.current?.scrollToTick(redo.regions[0].startTick, "start"); seekTick(redo.regions[0].startTick); }}
        onFocusRegion={(region) => { rollApiRef.current?.scrollToTick(region.startTick, "start"); seekTick(region.startTick); }}
        onPickRedo={(redo, index) => applyEditorChange({ type: "pickRedoTake", redoId: redo.id, index })}
      />

      <div className="edit-toolbar">
        <div className="edit-transport">
          <button className={"edit-play" + (editor.playing ? " playing" : "")} onClick={togglePlay} aria-label={editor.playing ? "Pause" : "Play"} title="Play / pause (Space)">
            {editor.playing ? <I.pause /> : <I.play />}
          </button>
          <span className="edit-time">{fmtTime(editor.playhead.time)} <i>/ {fmtTime(editor.playhead.duration || doc.durationSec)}</i></span>
          <button
            className={"edit-loop" + (loop ? " on" : "")}
            onClick={() => setLoopOn((v) => !v)}
            disabled={!canLoop}
            aria-pressed={Boolean(loop)}
            title={canLoop ? "Loop the selection (L)" : "Select something to loop"}
          >
            ⟲ Loop
          </button>
        </div>

        <EditOverview
          doc={doc}
          bars={bars}
          sections={sections}
          regions={targetRegions}
          pending={pending}
          view={view}
          playheadTick={playheadTick}
          endTick={songEndTick}
          onJump={(tick) => { rollApiRef.current?.scrollToTick(tick); seekTick(tick); }}
          onSection={pickSection}
        />

        <div className="edit-view-controls">
          <label className="edit-snap" title="Notes snap to this grid">
            <I.grid />
            <select value={editor.snap} onChange={(e) => setEditorSnap(e.target.value)} aria-label="Snap">
              {SNAP_OPTIONS.map((option) => (
                <option key={option} value={option}>{option === "off" ? "Free" : option}</option>
              ))}
            </select>
          </label>
          <div className="edit-zoom">
            <button onClick={() => rollApiRef.current?.zoom(0.8)} aria-label="Zoom out" title="Zoom out (−)"><I.minus /></button>
            <button onClick={() => rollApiRef.current?.zoom(1.25)} aria-label="Zoom in" title="Zoom in (+)"><I.plus /></button>
          </div>
        </div>
      </div>

      <div className="edit-roll">
        <PianoRollEditor
          project={project}
          bars={bars}
          sections={sections}
          regions={targetRegions}
          onPickSection={pickSection}
          onSelectBars={selectBarSpan}
          onBoxSelect={boxSelect}
          onClearSelection={clearAll}
          onNoteClick={() => setRegions([])}
          onResizeSelection={selectSpans}
          pending={pending}
          loop={loop}
          apiRef={rollApiRef}
          onViewChange={setView}
        />
      </div>

      {statusMsg && busyAction !== "generating" && <div className="edit-toast">{statusMsg}</div>}
    </div>
  );
}

// Mouse and key reference, opened from the ? in the header so the screen
// itself stays free of instructions.
function EditHelp() {
  const Kbd = ({ children }) => <kbd className="edit-kbd">{children}</kbd>;
  return (
    <div className="edit-menu edit-help">
      <div className="insp-eyebrow">MOUSE</div>
      <dl className="insp-keys">
        <dt>Click empty space</dt><dd>Add a note</dd>
        <dt>Drag</dt><dd>Select notes and their bars</dd>
        <dt>Click a section</dt><dd>Select it and jump there</dd>
        <dt><Kbd>Shift</Kbd> + click</dt><dd>Add to the selection</dd>
        <dt>Drag a note</dt><dd>Move it</dd>
        <dt>Drag a note's end</dt><dd>Sustain</dd>
        <dt>Right-click</dt><dd>Delete</dd>
        <dt><Kbd>Ctrl</Kbd> + wheel</dt><dd>Zoom</dd>
      </dl>
      <div className="insp-eyebrow">KEYS</div>
      <dl className="insp-keys">
        <dt><Kbd>Space</Kbd></dt><dd>Play / pause</dd>
        <dt><Kbd>R</Kbd></dt><dd>Redo the selection</dd>
        <dt><Kbd>L</Kbd></dt><dd>Loop</dd>
        <dt><Kbd>T</Kbd> <Kbd>H</Kbd> <Kbd>S</Kbd> <Kbd>Q</Kbd></dt><dd>Tap, HOPO, star power, snap</dd>
        <dt><Kbd>Del</Kbd></dt><dd>Delete notes</dd>
        <dt><Kbd>Ctrl</Kbd> <Kbd>Z</Kbd></dt><dd>Undo</dd>
        <dt><Kbd>Esc</Kbd></dt><dd>Clear the selection</dd>
      </dl>
    </div>
  );
}
