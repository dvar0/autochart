import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { handEditedRegions } from "./editorReducer.js";
import {
  barEndTick,
  barIndexAt,
  buildBarGrid,
  normalizeRegions,
  redoLabel,
  regionsCover,
  selectionLabel,
  sectionsFromDoc,
  subtractSpan,
} from "./editRegions.js";
import { startRedo } from "./inpaintService.js";

// State and actions behind the Regenerate and Edit tabs. It lives at the page
// level, beside the shared preview highway, so a trip to the Generate tab
// keeps a running regenerate, the style picks, the loop and the playhead.
//
// Two tabs, two selections. Regenerate picks whole bars (sections, or spans
// dragged on the roll) and makes new takes of them; Edit picks single notes
// for the note tools. Each tab keeps its selection while the other is open,
// and the roll only answers to the open tab. Every change autosaves into the
// edited draft take; the source take is never touched.
export default function useEditWorkspace(project, highwayRef, visible = true) {
  const {
    editor,
    workTab,
    openWorkTab,
    applyEditorChange,
    undoEditorChange,
    redoEditorChange,
    setEditorPlayhead,
  } = project;
  const active = visible && workTab !== "generate";
  const tab = workTab !== "generate" ? workTab : "regen";
  const doc = editor.doc;
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
  const [helpOpen, setHelpOpen] = useState(false);
  // A regenerate or take switch that would replace hand edits waits here for
  // the user to confirm it.
  const [confirm, setConfirm] = useState(null);
  // How a drag on the roll would leave the picked areas, for the song strip.
  const [dragPreview, setDragPreview] = useState(null);

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
  const selectionName = selectionLabel(bars, regions, sections);
  // The redo whose bars are exactly the selection; its takes show in the panel.
  const selectedRedo = useMemo(() => redos.find((redo) =>
    redo.regions.length === regions.length &&
    redo.regions.every((r, i) => r.startTick === regions[i].startTick && r.endTick === regions[i].endTick)
  ) || null, [redos, regions]);

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
  // The highway keeps playing across tabs. Coming back, the roll and the song
  // map pick up wherever it is.
  useEffect(() => {
    if (!active) return undefined;
    const progress = highwayRef.current?.getProgress?.();
    if (progress) setEditorPlayhead({ time: progress.time, duration: progress.duration || doc?.durationSec || 0 });
    const frame = requestAnimationFrame(() => {
      if (!doc) return;
      rollApiRef.current?.scrollToTick(doc.tempoMap.secondsToTick(progress?.time || 0));
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, doc?.chartText]);

  useEffect(() => {
    if (!editor.seekRequest) return;
    highwayRef.current?.seek?.(editor.seekRequest.seconds);
  }, [editor.seekRequest, highwayRef]);

  const togglePlay = useCallback(() => {
    const preview = highwayRef.current;
    if (!preview) return;
    if (preview.isPlaying?.()) {
      preview.pause?.();
      return;
    }
    const looping = loopRef.current;
    if (looping && doc) {
      const tick = doc.tempoMap.secondsToTick(editor.playhead.time || 0);
      if (tick < looping.startTick || tick >= looping.endTick) preview.seek?.(doc.tempoMap.tickToSeconds(looping.startTick));
    }
    preview.play?.();
  }, [doc, editor.playhead.time, highwayRef]);

  useEffect(() => {
    if (!editor.playRequest) return;
    togglePlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.playRequest]);

  const onProgress = useCallback((time, duration) => {
    setEditorPlayhead({ time, duration });
    const looping = loopRef.current;
    if (!looping || !doc || !highwayRef.current?.isPlaying?.()) return;
    if (time >= doc.tempoMap.tickToSeconds(looping.endTick)) {
      highwayRef.current.seek(doc.tempoMap.tickToSeconds(looping.startTick));
    }
  }, [doc, setEditorPlayhead, highwayRef]);

  const seekTick = useCallback((tick) => {
    if (!doc) return;
    highwayRef.current?.seek?.(doc.tempoMap.tickToSeconds(Math.max(0, tick)));
  }, [doc, highwayRef]);

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
  }, [seekTick, highwayRef]);

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

  const focusTick = useCallback((tick) => {
    rollApiRef.current?.scrollToTick(tick, "start");
    seekTick(tick);
  }, [seekTick]);

  // ---- regenerate ----
  const runRedo = useCallback((targetRegions, { redoId = null, label }) => {
    if (!doc || pending || !targetRegions.length) return;
    const total = targetRegions.reduce((sum, r) => sum + barIndexAt(bars, r.endTick - 1) - barIndexAt(bars, r.startTick) + 1, 0);
    setPending({ regions: targetRegions, notes: [], done: 0, total, label });
    const job = startRedo({
      doc,
      bars,
      regions: targetRegions,
      knobs,
      run: editor.startInpaint,
      onProgress: ({ done, total: of, notes }) => setPending((current) => (current ? { ...current, done, total: of ?? current.total, notes } : current)),
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
  }, [doc, pending, bars, knobs, editor, applyEditorChange, setRegions, seekTick]);

  useEffect(() => () => jobRef.current?.cancel(), []);

  // Another take opened: nothing from the last one carries over.
  const sessionKey = doc?.chartText;
  useEffect(() => {
    jobRef.current?.cancel();
    setLoopOn(false);
    setConfirm(null);
    setDragPreview(null);
  }, [sessionKey]);

  // Anything that would write over notes changed by hand asks first.
  const guardHandEdits = useCallback((targetRegions, kind, run) => {
    const edited = handEditedRegions(doc, targetRegions);
    if (!edited.length) {
      run();
      return;
    }
    setConfirm({ kind, regions: edited, run });
  }, [doc]);

  // Redoing the exact bars of an earlier redo adds a take to it, so its
  // Original stays reachable.
  const redoSelection = useCallback(() => {
    if (!regions.length || pending || editor.inpaintBlockedReason) return;
    guardHandEdits(regions, "regen", () =>
      runRedo(regions, { redoId: selectedRedo?.id ?? null, label: selectedRedo?.label ?? redoLabel(bars, regions, sections) })
    );
  }, [regions, pending, editor.inpaintBlockedReason, guardHandEdits, runRedo, selectedRedo, bars, sections]);

  const pickRedoTake = useCallback((redo, index) => {
    guardHandEdits(redo.regions, "take", () => applyEditorChange({ type: "pickRedoTake", redoId: redo.id, index }));
  }, [guardHandEdits, applyEditorChange]);

  const confirmOverwrite = useCallback(() => {
    const run = confirm?.run;
    setConfirm(null);
    run?.();
  }, [confirm]);
  const cancelOverwrite = useCallback(() => setConfirm(null), []);

  // ---- selection ----
  // Esc clears the open tab's selection only.
  const clearSelection = useCallback(() => {
    if (tab === "regen") setRegions([]);
    else applyEditorChange({ type: "clearSelection" });
  }, [applyEditorChange, setRegions, tab]);

  // Clicking a section moves the playhead to its start and scrolls the roll
  // there. On the Regenerate tab it also adds the section to the picked bars,
  // or takes it out if it is already picked, the same toggle as clicking bars
  // on the roll. Unpicking a section right after picking it puts back
  // whatever was picked before, so a partial pick inside it survives the
  // round trip.
  const pickSection = (section) => {
    const span = { startTick: section.startTick, endTick: section.endTick };
    if (tab === "regen") {
      const covered = regionsCover(regions, span);
      const last = sectionPickRef.current;
      sectionPickRef.current = null;
      if (covered) {
        const undoPick = last?.id === section.id && last.after === regions;
        setRegions(undoPick ? last.before : subtractSpan(regions, span));
        return;
      }
      const after = normalizeRegions([...regions, span]);
      setRegions(after);
      sectionPickRef.current = { id: section.id, before: regions, after };
    }
    focusTick(span.startTick);
  };

  const removeArea = (region) => setRegions(subtractSpan(regions, region));
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
  keyActions.current = { tab, togglePlay, noteAction, redoSelection, regions, pending, canLoop, clearSelection, jumpSection, confirm, confirmOverwrite, cancelOverwrite, openWorkTab };
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const a = keyActions.current;
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (a.confirm) {
        if (e.key === "Escape") a.cancelOverwrite();
        else if (e.key === "Enter") a.confirmOverwrite();
        else return;
        e.preventDefault();
        return;
      }
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
        a.openWorkTab(a.tab === "regen" ? "edit" : "regen");
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
        if (key === "r" && a.regions.length && !a.pending) a.redoSelection();
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
  }, [active, redoEditorChange, undoEditorChange]);

  useEffect(() => {
    if (!helpOpen) return undefined;
    const close = () => setHelpOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [helpOpen]);

  useEffect(() => {
    if (!active) setHelpOpen(false);
  }, [active]);

  return {
    active,
    tab,
    doc,
    bars,
    sections,
    regions,
    redos,
    selectedNotes,
    selectionName,
    selectedRedo,
    songEndTick,
    pending,
    regenBlockedReason: editor.inpaintBlockedReason,
    knobs,
    setKnob: (key, value) => setKnobs((current) => ({ ...current, [key]: value })),
    loop,
    canLoop,
    toggleLoop: () => setLoopOn((v) => !v),
    view,
    setView,
    dragPreview,
    setDragPreview,
    helpOpen,
    setHelpOpen,
    confirm,
    confirmOverwrite,
    cancelOverwrite,
    rollApiRef,
    onProgress,
    togglePlay,
    scrub,
    focusTick,
    pickSection,
    removeArea,
    setRegions,
    boxSelect,
    clearSelection,
    noteAction,
    redoSelection,
    pickRedoTake,
    cancelRedo: () => jobRef.current?.cancel(),
    focusRedo: (redo) => {
      setRegions(redo.regions);
      focusTick(redo.regions[0].startTick);
    },
  };
}
