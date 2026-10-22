import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { alikeRegenPicks, mostAlikeRecordPicks } from "./alike.js";
import { buildEditorPreviewTrack } from "./chartEditor.js";
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
import { MAX_COMPARE_CHARTS, MIN_COMPARE_CHARTS } from "../useGenerateProject.js";

// Regenerate writes this many versions of each area (remembered per machine).
export const TRIES_OPTIONS = [1, 2, 4, 8];
const TRIES_KEY = "autochart.regenerate.tries";

function readTries() {
  try {
    const n = Number(localStorage.getItem(TRIES_KEY));
    return TRIES_OPTIONS.includes(n) ? n : 1;
  } catch {
    return 1;
  }
}

// State and actions behind the Regenerate and Edit tabs. It lives at the page
// level, beside the shared preview highway, so a trip to the Generate tab
// keeps a running regenerate, the style knobs, the loop and the playhead.
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
  // Style knobs as on Generate: "auto" or a bin "0".."6", by knob id.
  const [knobs, setKnobs] = useState({});
  const [tries, setTriesState] = useState(readTries);
  const setTries = useCallback((n) => {
    setTriesState(n);
    try {
      localStorage.setItem(TRIES_KEY, String(n));
    } catch {
      // Remembering is a convenience.
    }
  }, []);
  const [loopOn, setLoopOn] = useState(false);
  // Compare, as on Generate: check up to four versions of regenerated areas
  // ("redoId:index", index -1 = Original) and the stage shows them side by
  // side. The stage carries the playhead across the swap.
  const [compareMarks, setCompareMarks] = useState([]);
  const [compareOn, setCompareOn] = useState(false);
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
  // While a regenerate runs, the highway plays the take with the areas being
  // written showing only the notes streamed so far, like the roll.
  const previewTrack = useMemo(() => {
    if (!pending || !doc) return editor.previewTrack;
    const inPending = (note) => pending.regions.some((r) => note.tick >= r.startTick && note.tick < r.endTick);
    const notes = [...doc.notes.filter((note) => !inPending(note)), ...pending.notes].sort((a, b) => a.tick - b.tick);
    return buildEditorPreviewTrack({ ...doc, notes });
  }, [pending, doc, editor.previewTrack]);

  // Marks whose area or try is gone drop out; under two, compare closes.
  const liveMarks = useMemo(() => compareMarks.filter((mark) => {
    const [redoId, index] = mark.split(":");
    const redo = redos.find((r) => r.id === redoId);
    return redo && Number(index) < redo.takes.length;
  }), [compareMarks, redos]);
  const comparing = compareOn && liveMarks.length >= MIN_COMPARE_CHARTS;
  // Each checked version is the whole take with that one area swapped in.
  // `updatedAt` bumps on every rebuild so the joined view redraws them.
  const compareRevRef = useRef(0);
  const compareCharts = useMemo(() => {
    if (!comparing || !doc) return [];
    const rev = ++compareRevRef.current;
    return liveMarks.map((mark) => {
      const [redoId, rawIndex] = mark.split(":");
      const index = Number(rawIndex);
      const redo = redos.find((r) => r.id === redoId);
      const { startTick, endTick } = redo.region;
      const inArea = (note) => note.tick >= startTick && note.tick < endTick;
      const notes = [...doc.notes.filter((note) => !inArea(note)), ...(index < 0 ? redo.original : redo.takes[index])]
        .sort((a, b) => a.tick - b.tick);
      return {
        id: mark,
        updatedAt: rev,
        name: `${redo.label} · ${index < 0 ? "Original" : `Try ${index + 1}`}`,
        track: buildEditorPreviewTrack({ ...doc, notes }),
      };
    });
  }, [comparing, liveMarks, redos, doc]);
  // Checking boxes is the compare: any change that leaves two or more checked
  // opens it, like on Generate; under two closes it.
  const toggleCompareMark = useCallback((redo, index) => {
    const mark = `${redo.id}:${index}`;
    const next = liveMarks.includes(mark)
      ? liveMarks.filter((m) => m !== mark)
      : liveMarks.length >= MAX_COMPARE_CHARTS ? liveMarks : [...liveMarks, mark];
    setCompareMarks(next);
    setCompareOn(next.length >= MIN_COMPARE_CHARTS);
  }, [liveMarks]);
  const toggleCompare = useCallback(() => setCompareOn(!comparing), [comparing]);
  useEffect(() => {
    if (compareOn && liveMarks.length < MIN_COMPARE_CHARTS) setCompareOn(false);
  }, [compareOn, liveMarks.length]);

  // "Pick most alike": what it would switch, so the button knows if it can.
  const alikePicks = useMemo(() => (doc ? mostAlikeRecordPicks(redos, doc, sections) : []), [doc, redos, sections]);

  // One loop per picked area (or per regenerated area when nothing is
  // picked), each with a bar of run-in and run-out so both seams are heard.
  // The loop that plays is the one the playhead is in; outside all of them
  // playback just runs.
  const loops = useMemo(() => {
    if (!loopOn || !bars.length) return [];
    const target = regions.length ? regions : redos.map((redo) => redo.region);
    return target.map((area) => ({
      area,
      startTick: bars[Math.max(0, barIndexAt(bars, area.startTick) - 1)],
      endTick: barEndTick(bars, Math.min(bars.length - 1, barIndexAt(bars, area.endTick - 1) + 1)),
    }));
  }, [loopOn, regions, redos, bars]);
  const loopsRef = useRef(loops);
  loopsRef.current = loops;
  const [activeLoop, setActiveLoop] = useState(-1);
  const activeLoopRef = useRef(-1);
  const lastTimeRef = useRef(null);
  const canLoop = Boolean(regions.length || redos.length);

  // The loop holding a tick: the playing one if it still does, else the one
  // whose area holds it, else any whose run-in or run-out does.
  const loopAt = useCallback((tick) => {
    const spans = loopsRef.current;
    const current = spans[activeLoopRef.current];
    if (current && tick >= current.startTick && tick < current.endTick) return activeLoopRef.current;
    const inArea = spans.findIndex((l) => tick >= l.area.startTick && tick < l.area.endTick);
    return inArea >= 0 ? inArea : spans.findIndex((l) => tick >= l.startTick && tick < l.endTick);
  }, []);
  const updateActiveLoop = useCallback((index) => {
    if (activeLoopRef.current === index) return;
    activeLoopRef.current = index;
    setActiveLoop(index);
  }, []);
  useEffect(() => {
    if (!doc) return;
    activeLoopRef.current = -1;
    updateActiveLoop(loopAt(doc.tempoMap.secondsToTick(editor.playhead.time || 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loops]);

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
    if (preview.isPlaying?.()) preview.pause?.();
    else preview.play?.();
  }, [highwayRef]);

  useEffect(() => {
    if (!editor.playRequest) return;
    togglePlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.playRequest]);

  // Playing across the playing loop's end wraps to its start. A jump (a seek
  // or scrub) lands wherever it lands, and the loop there takes over.
  const onProgress = useCallback((time, duration) => {
    setEditorPlayhead({ time, duration });
    const prev = lastTimeRef.current;
    lastTimeRef.current = time;
    if (!doc || !loopsRef.current.length) return;
    const current = loopsRef.current[activeLoopRef.current];
    if (current && prev != null && highwayRef.current?.isPlaying?.()) {
      const end = doc.tempoMap.tickToSeconds(current.endTick);
      if (prev < end && time >= end && time - prev < 0.75) {
        lastTimeRef.current = null;
        highwayRef.current.seek(doc.tempoMap.tickToSeconds(current.startTick));
        return;
      }
    }
    updateActiveLoop(loopAt(doc.tempoMap.secondsToTick(time)));
  }, [doc, setEditorPlayhead, highwayRef, loopAt, updateActiveLoop]);

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
  const runRedo = useCallback((targetRegions) => {
    if (!doc || pending || !targetRegions.length) return;
    const total = targetRegions.reduce((sum, r) => sum + barIndexAt(bars, r.endTick - 1) - barIndexAt(bars, r.startTick) + 1, 0) * tries;
    setPending({ regions: targetRegions, notes: [], done: 0, total, try: 0, tries });
    const knobBins = {};
    for (const knob of editor.inpaintKnobs) {
      const value = knobs[knob.id];
      if (value != null && value !== "auto") knobBins[knob.id] = Number(value);
    }
    const job = startRedo({
      doc,
      bars,
      regions: targetRegions,
      knobs: knobBins,
      tries,
      run: editor.startInpaint,
      onProgress: ({ done, total: of, try: at, notes }) =>
        setPending((current) => (current ? { ...current, done, total: of ?? current.total, try: at ?? current.try, notes } : current)),
    });
    jobRef.current = job;
    job.promise
      .then(({ areas: results }) => {
        const areas = results.map((result) => {
          const region = { startTick: result.startTick, endTick: result.endTick };
          return { region, label: redoLabel(bars, [region], sections), tries: result.tries, seams: result.seams, pick: result.chosen };
        });
        applyEditorChange({ type: "applyRedo", areas: alikeRegenPicks(areas, doc, sections) });
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
  }, [doc, pending, bars, sections, knobs, tries, editor, applyEditorChange, setRegions, seekTick]);

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

  // Regenerating an area's exact bars again adds tries to it, so its
  // original and earlier tries stay reachable.
  const redoSelection = useCallback(() => {
    if (!regions.length || pending || editor.inpaintBlockedReason) return;
    guardHandEdits(regions, "regen", () => runRedo(regions));
  }, [regions, pending, editor.inpaintBlockedReason, guardHandEdits, runRedo]);

  const pickRedoTake = useCallback((redo, index) => {
    guardHandEdits([redo.region], "take", () => applyEditorChange({ type: "pickRedoTakes", picks: [{ redoId: redo.id, index }] }));
  }, [guardHandEdits, applyEditorChange]);

  const pickMostAlike = useCallback(() => {
    if (!alikePicks.length) return;
    const regionsTouched = alikePicks.map((pick) => redos.find((r) => r.id === pick.redoId).region);
    guardHandEdits(regionsTouched, "take", () => applyEditorChange({ type: "pickRedoTakes", picks: alikePicks }));
  }, [alikePicks, redos, guardHandEdits, applyEditorChange]);

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
    previewTrack,
    songEndTick,
    pending,
    regenBlockedReason: editor.inpaintBlockedReason,
    styleKnobs: editor.inpaintKnobs,
    knobs,
    setKnob: (id, value) => setKnobs((current) => ({ ...current, [id]: value })),
    setAllKnobsAuto: () => setKnobs({}),
    tries,
    setTries,
    loopOn,
    loops,
    activeLoop,
    canLoop,
    toggleLoop: () => setLoopOn((v) => !v),
    compareMarks: liveMarks,
    toggleCompareMark,
    comparing,
    compareCharts,
    toggleCompare,
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
    canPickMostAlike: alikePicks.length > 0,
    pickMostAlike,
    cancelRedo: () => jobRef.current?.cancel(),
    focusRedo: (redo) => {
      setRegions([redo.region]);
      focusTick(redo.region.startTick);
    },
  };
}
