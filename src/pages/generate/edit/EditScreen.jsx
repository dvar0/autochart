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
// Two tabs, two selections. Regenerate picks whole bars (sections, or spans
// dragged on the roll) and makes new takes of them; Edit picks single notes
// for the note tools. Each tab keeps its selection while the other is open,
// and the roll only answers to the open tab. Every change autosaves into the
// edited draft take; the source take is never touched.

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

  // The Regenerate tab's picked bars live in the editor state so Undo covers
  // them too.
  const regions = editor.regions;
  const setRegions = useCallback((next) => applyEditorChange({ type: "setRegions", regions: next }), [applyEditorChange]);
  const sectionPickRef = useRef(null);
  const [pending, setPending] = useState(null);
  const [knobs, setKnobs] = useState({ density: "auto", chords: "auto", movement: "auto" });
  const [loopOn, setLoopOn] = useState(false);
  const [view, setView] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tab, setTab] = useState("regen");
  // How a drag on the roll would leave the picked areas, for the song strip.
  const [dragPreview, setDragPreview] = useState(null);
  const [toast, setToast] = useState("");

  // statusMsg is shared with the console, where it stays put; here it's a
  // floating toast over the roll, so it clears itself.
  useEffect(() => {
    setToast(statusMsg || "");
    if (!statusMsg) return undefined;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [statusMsg]);

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
  // The bars Regenerate would rewrite (the Regenerate tab's selection).
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

  // The song map's timeline: the playhead and the roll follow the pointer.
  // Playback holds while the pointer is down and picks up where it lets go.
  const scrubResumeRef = useRef(false);
  const scrub = useCallback((tick, phase) => {
    const preview = highwayRef.current;
    if (phase === "start") {
      scrubResumeRef.current = Boolean(preview?.isPlaying?.());
      if (scrubResumeRef.current) preview.pause?.();
    }
    seekTick(tick);
    rollApiRef.current?.scrollToTick(tick);
    if (phase === "end" && scrubResumeRef.current) {
      scrubResumeRef.current = false;
      preview?.play?.();
    }
  }, [seekTick]);

  // [ and ] jump to the start of the previous or next section. A press just
  // after a section starts goes back past it, like a music player's back.
  const jumpSection = useCallback((dir) => {
    if (!doc || !sections.length) return;
    const now = doc.tempoMap.secondsToTick(editor.playhead.time || 0);
    const grace = (doc.resolution || 192) * 2;
    const starts = sections.map((s) => s.startTick);
    const target = dir > 0
      ? starts.find((t) => t > now + 1)
      : [...starts].reverse().find((t) => t < now - grace) ?? 0;
    if (target == null) return;
    seekTick(target);
    rollApiRef.current?.scrollToTick(target, "start");
  }, [doc, sections, editor.playhead.time, seekTick]);

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
        // The bars stay selected, so Regenerate again tries another take.
        setRegions(targetRegions);
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

  // ---- selection ----
  const selectSpans = setRegions;

  // Esc clears the open tab's selection only.
  const clearSelection = useCallback(() => {
    if (tab === "regen") setRegions([]);
    else applyEditorChange({ type: "clearSelection" });
  }, [applyEditorChange, tab]);

  // Clicking a section moves the playhead to its start and scrolls the roll
  // there. On the Regenerate tab it also adds the section to the picked bars,
  // or takes it out if it is already picked, the same toggle as clicking bars
  // on the roll. Unpicking a section right after picking it puts back
  // whatever was picked before, so a partial pick inside it survives the
  // round trip.
  const pickSection = (section) => {
    const span = { startTick: section.startTick, endTick: section.endTick };
    if (tab === "regen") {
      const covered = regionsCover(targetRegions, span);
      const last = sectionPickRef.current;
      sectionPickRef.current = null;
      if (covered) {
        const undoPick = last?.id === section.id && last.after === targetRegions;
        selectSpans(undoPick ? last.before : subtractSpan(targetRegions, span));
        return;
      }
      const after = normalizeRegions([...targetRegions, span]);
      selectSpans(after);
      sectionPickRef.current = { id: section.id, before: targetRegions, after };
    }
    seekTick(span.startTick);
    rollApiRef.current?.scrollToTick(span.startTick, "start");
  };


  const removeArea = (region) => selectSpans(subtractSpan(targetRegions, region));

  const boxSelect = (noteIds, additive) => applyEditorChange({ type: "select", noteIds, additive });

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
  keyActions.current = { tab, togglePlay, noteAction, redoSelection, targetRegions, pending, canLoop, clearSelection, jumpSection };
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
      } else if (e.key === "Tab") {
        e.preventDefault();
        setTab((t) => (t === "regen" ? "edit" : "regen"));
      } else if (e.key === " ") {
        e.preventDefault();
        a.togglePlay();
      } else if (e.key === "Escape") {
        a.clearSelection();
        setHelpOpen(false);
      } else if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        a.jumpSection(e.key === "]" ? 1 : -1);
      } else if (key === "l" && a.canLoop) setLoopOn((v) => !v);
      else if (a.tab === "regen") {
        if (key === "r" && a.targetRegions.length && !a.pending) a.redoSelection();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        a.noteAction("delete");
      } else if (key === "t") a.noteAction("tap");
      else if (key === "h") a.noteAction("force");
      else if (key === "s") a.noteAction("starPower");
      else if (key === "q") a.noteAction("quantize");
      if (e.key === "=" || e.key === "+") rollApiRef.current?.zoom(1.25);
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
          <div className="edit-history">
            <button onClick={undoEditorChange} disabled={!editor.canUndo} title="Undo (Ctrl+Z)"><I.undo /> Undo</button>
            <button onClick={redoEditorChange} disabled={!editor.canRedo} title="Redo (Ctrl+Shift+Z)"><I.redo /> Redo</button>
          </div>
          <div className="edit-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button className="edit-icon-btn" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen} aria-label="Mouse and keys" title="Mouse and keys"><I.info /></button>
            {helpOpen && <EditHelp tab={tab} />}
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
        tab={tab}
        onTab={setTab}
        snap={editor.snap}
        onSnap={setEditorSnap}
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
        onRemoveArea={removeArea}
        onClearAreas={() => selectSpans([])}
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
          regions={tab === "regen" ? dragPreview?.regions || targetRegions : []}
          lifted={dragPreview?.active || null}
          origin={dragPreview?.origin || null}
          pending={pending}
          view={view}
          playheadTick={playheadTick}
          endTick={songEndTick}
          onScrub={scrub}
          onSection={pickSection}
        />

        <div className="edit-view-controls">
          <div className="edit-zoom">
            <button onClick={() => rollApiRef.current?.zoom(0.8)} aria-label="Zoom out" title="Zoom out (−)"><I.minus /></button>
            <button onClick={() => rollApiRef.current?.zoom(1.25)} aria-label="Zoom in" title="Zoom in (+)"><I.plus /></button>
          </div>
        </div>
      </div>

      <div className="edit-roll">
        <PianoRollEditor
          project={project}
          mode={tab}
          bars={bars}
          sections={sections}
          regions={tab === "regen" ? targetRegions : []}
          onPickSection={pickSection}
          onBoxSelect={boxSelect}
          onClearSelection={clearSelection}
          onSetSelection={selectSpans}
          onPreviewSelection={setDragPreview}
          songEndTick={songEndTick}
          pending={pending}
          loop={loop}
          apiRef={rollApiRef}
          onViewChange={setView}
        />
      </div>

      {toast && busyAction !== "generating" && <div className="edit-toast">{toast}</div>}
    </div>
  );
}

// Mouse and key reference for the open tab, opened from the ? in the header
// so the screen itself stays free of instructions.
function EditHelp({ tab }) {
  const Kbd = ({ children }) => <kbd className="edit-kbd">{children}</kbd>;
  return (
    <div className="edit-menu edit-help">
      <div className="insp-eyebrow">MOUSE</div>
      {tab === "regen" ? (
        <dl className="insp-keys">
          <dt>Click a section or bar</dt><dd>Pick it, or unpick it</dd>
          <dt>Click or drag the timeline</dt><dd>Move the playhead</dd>
          <dt>[ ] on the timeline</dt><dd>What the roll shows</dd>
          <dt><Kbd>Alt</Kbd> + drag the timeline</dt><dd>Don't snap to sections</dd>
          <dt>Drag across the roll</dt><dd>Pick bars</dd>
          <dt>Drag over picked bars</dt><dd>Unpick them</dd>
          <dt>Right-drag</dt><dd>Unpick bars</dd>
          <dt>Drag a bar-row block</dt><dd>Move that area</dd>
          <dt>Drag its grips</dt><dd>Stretch it</dd>
          <dt>Click its arrow</dt><dd>Stretch it to the end</dd>
          <dt>Wheel</dt><dd>Scroll the roll</dd>
          <dt><Kbd>Ctrl</Kbd> + wheel</dt><dd>Zoom</dd>
        </dl>
      ) : (
        <dl className="insp-keys">
          <dt>Click a section</dt><dd>Jump to it</dd>
          <dt>Click or drag the timeline</dt><dd>Move the playhead</dd>
          <dt>[ ] on the timeline</dt><dd>What the roll shows</dd>
          <dt><Kbd>Alt</Kbd> + drag the timeline</dt><dd>Don't snap to sections</dd>
          <dt>Click empty space</dt><dd>Add a note</dd>
          <dt>Drag</dt><dd>Select notes</dd>
          <dt><Kbd>Shift</Kbd> + click</dt><dd>Add to the selection</dd>
          <dt>Drag a note</dt><dd>Move it</dd>
          <dt>Drag a note's end</dt><dd>Sustain</dd>
          <dt>Right-click</dt><dd>Delete</dd>
          <dt>Wheel</dt><dd>Scroll the roll</dd>
          <dt><Kbd>Ctrl</Kbd> + wheel</dt><dd>Zoom</dd>
        </dl>
      )}
      <div className="insp-eyebrow">KEYS</div>
      <dl className="insp-keys">
        <dt><Kbd>Tab</Kbd></dt><dd>Switch tabs</dd>
        <dt><Kbd>Space</Kbd></dt><dd>Play / pause</dd>
        <dt><Kbd>[</Kbd> <Kbd>]</Kbd></dt><dd>Previous / next section</dd>
        <dt><Kbd>L</Kbd></dt><dd>Loop</dd>
        {tab === "regen" ? (
          <><dt><Kbd>R</Kbd></dt><dd>Regenerate the selection</dd></>
        ) : (
          <>
            <dt><Kbd>T</Kbd> <Kbd>H</Kbd> <Kbd>S</Kbd> <Kbd>Q</Kbd></dt><dd>Tap, HOPO, star power, snap</dd>
            <dt><Kbd>Del</Kbd></dt><dd>Delete notes</dd>
          </>
        )}
        <dt><Kbd>Ctrl</Kbd> <Kbd>Z</Kbd></dt><dd>Undo</dd>
        <dt><Kbd>Esc</Kbd></dt><dd>Clear the selection</dd>
      </dl>
    </div>
  );
}
