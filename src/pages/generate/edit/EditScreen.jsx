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
  sectionsFromDoc,
  selectionLabel,
} from "./editRegions.js";
import { startRedo } from "./inpaintService.js";

// The full-screen chart editor. Preview on top, the whole-width timeline
// (song map, transport, piano roll) below. Two layers share the timeline:
// Redo (pick bars or sections, let the model rewrite them, flip between
// takes) and touch-up (click, drag and right-click notes in the roll). Only
// one kind of selection exists at a time: picked bars or picked notes.
// Every change autosaves into the edited draft take; the source take is never
// touched.

const NOTE_ACTIONS = [
  { id: "tap", label: "Tap", key: "T", icon: I.bolt, tone: "tap" },
  { id: "force", label: "HOPO", key: "H", icon: I.chevsRight, tone: "force" },
  { id: "starPower", label: "Star power", key: "S", icon: I.starOutline, tone: "sp" },
  { id: "solo", label: "Solo", icon: I.spark, tone: "solo" },
  { id: "quantize", label: "Snap", key: "Q", icon: I.grid },
  { id: "split", label: "Split chord", icon: I.cut, needsChord: true },
  { id: "delete", label: "Delete", key: "Del", icon: I.trash, tone: "danger" },
];

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

  const songEndTick = useMemo(() => {
    if (!doc) return 0;
    const seconds = Math.max(doc.durationSec || 0, editor.playhead.duration || 0);
    return Math.ceil(doc.tempoMap.secondsToTick(seconds));
  }, [doc, editor.playhead.duration]);
  const bars = useMemo(() => buildBarGrid(doc, songEndTick), [doc?.sync, doc?.resolution, songEndTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const sections = useMemo(() => sectionsFromDoc(doc, songEndTick), [doc?.events, songEndTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectionName = selectionLabel(bars, regions, sections);
  const redos = doc?.redos || [];

  // Loop the picked bars, or the newest redo, with a bar of run-in and run-out
  // so both seams are heard.
  const loop = useMemo(() => {
    if (!loopOn || !bars.length) return null;
    const target = regions.length ? regions : redos[redos.length - 1]?.regions;
    if (!target?.length) return null;
    const first = barIndexAt(bars, target[0].startTick);
    const last = barIndexAt(bars, target[target.length - 1].endTick - 1);
    return { startTick: bars[Math.max(0, first - 1)], endTick: barEndTick(bars, Math.min(bars.length - 1, last + 1)) };
  }, [loopOn, regions, redos, bars]);
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const canLoop = Boolean(regions.length || redos.length);

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
        setRegions([]);
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

  const redoSelection = () => runRedo(regions, { label: selectionName });
  const redoToEnd = () => {
    const start = regions[0]?.startTick ?? bars[barIndexAt(bars, doc.tempoMap.secondsToTick(editor.playhead.time || 0))];
    const lastBar = barIndexAt(bars, Math.max(start, songEndTick - 1));
    const span = { startTick: start, endTick: barEndTick(bars, lastBar) };
    runRedo([span], { label: `Bar ${barIndexAt(bars, start) + 1} to the end` });
  };
  const redoMore = (redo) => runRedo(redo.regions, { redoId: redo.id, label: redo.label });

  // Picking bars drops any note selection, and selecting notes drops picked
  // bars, so the panels never show two selections at once.
  const pickRegions = useCallback((next) => {
    if (next.length && editor.selectedNoteIds.length) applyEditorChange({ type: "clearSelection" });
    setRegions(next);
  }, [applyEditorChange, editor.selectedNoteIds.length]);
  useEffect(() => {
    if (editor.selectedNoteIds.length) setRegions([]);
  }, [editor.selectedNoteIds]);

  const pickSection = (section, additive) => {
    const span = { startTick: section.startTick, endTick: section.endTick };
    const has = regions.some((r) => r.startTick === span.startTick && r.endTick === span.endTick);
    if (additive) pickRegions(has ? regions.filter((r) => r.startTick !== span.startTick) : normalizeRegions([...regions, span]));
    else pickRegions(has && regions.length === 1 ? [] : [span]);
    rollApiRef.current?.scrollToTick(span.startTick, "start");
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
  keyActions.current = { togglePlay, noteAction, redoSelection, regions, pending, canLoop };
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
        setRegions([]);
        applyEditorChange({ type: "clearSelection" });
      } else if (key === "t") a.noteAction("tap");
      else if (key === "h") a.noteAction("force");
      else if (key === "s") a.noteAction("starPower");
      else if (key === "q") a.noteAction("quantize");
      else if (key === "l" && a.canLoop) setLoopOn((v) => !v);
      else if (key === "r" && a.regions.length && !a.pending) a.redoSelection();
      else if (e.key === "=" || e.key === "+") rollApiRef.current?.zoom(1.25);
      else if (e.key === "-") rollApiRef.current?.zoom(0.8);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyEditorChange, redoEditorChange, undoEditorChange]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = () => setMenuOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  if (!doc) return null;

  const name = editor.draftVersion?.name || editor.sourceVersion?.name || "Editing";
  const diff = DIFF[doc.difficulty] || DIFF.expert;
  const saveLabel = editor.dirty ? "Saving…" : editor.savedAt ? "Saved" : "";
  const playheadTick = doc.tempoMap.secondsToTick(editor.playhead.time || 0);
  const selectedIds = new Set(editor.selectedNoteIds);
  const selectedNotes = doc.notes.filter((note) => selectedIds.has(note.id));
  const hasChord = selectedNotes.some((note) => !note.open && note.lanes.length > 1);

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
        bars={bars}
        doc={doc}
        regions={regions}
        selectionName={selectionName}
        pending={pending}
        knobs={knobs}
        onKnob={(key, value) => setKnobs((current) => ({ ...current, [key]: value }))}
        onRedo={redoSelection}
        onRedoToEnd={redoToEnd}
        onCancelRedo={() => jobRef.current?.cancel()}
        onClearRegions={() => setRegions([])}
        onRemoveRegion={(region) => setRegions(regions.filter((r) => r !== region))}
        onFocusRedo={(redo) => { rollApiRef.current?.scrollToTick(redo.regions[0].startTick, "start"); seekTick(redo.regions[0].startTick); }}
        onPickRedo={(redo, index) => applyEditorChange({ type: "pickRedoTake", redoId: redo.id, index })}
      />

      <div className="edit-map">
        <EditOverview
          doc={doc}
          bars={bars}
          sections={sections}
          regions={regions}
          pending={pending}
          view={view}
          playheadTick={playheadTick}
          endTick={songEndTick}
          onJump={(tick) => { rollApiRef.current?.scrollToTick(tick); seekTick(tick); }}
          onSection={pickSection}
        />
      </div>

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
            title={canLoop ? "Loop the picked bars (L)" : "Pick bars to loop"}
          >
            ⟲ Loop
          </button>
        </div>

        <div className="edit-context">
          {selectedNotes.length ? (
            <>
              <span className="edit-context-count">{selectedNotes.length} note{selectedNotes.length === 1 ? "" : "s"}</span>
              <div className="edit-note-actions">
                {NOTE_ACTIONS.map((action) => {
                  const Icon = action.icon;
                  return (
                    <button
                      key={action.id}
                      data-tone={action.tone}
                      onClick={() => noteAction(action.id)}
                      disabled={action.needsChord && !hasChord}
                      title={action.key ? `${action.label} (${action.key})` : action.label}
                    >
                      <Icon /> <span>{action.label}</span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="edit-hint">
              <span><b>Click</b> add note</span>
              <span><b>Drag</b> select</span>
              <span><b>Drag note end</b> sustain</span>
              <span><b>Right-click</b> delete</span>
            </p>
          )}
        </div>

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
          regions={regions}
          onRegionsChange={pickRegions}
          pending={pending}
          loop={loop}
          apiRef={rollApiRef}
          onViewChange={setView}
          onRedoMore={redoMore}
        />
      </div>

      {statusMsg && busyAction !== "generating" && <div className="edit-toast">{statusMsg}</div>}
    </div>
  );
}
