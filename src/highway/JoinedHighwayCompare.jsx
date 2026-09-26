import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { GameEngine } from "./GameEngine.js";
import { HighwayRenderer } from "./HighwayRenderer.js";
import HighwayBackground from "./HighwayBackground.jsx";
import { annotateNotes, markStarNotes, resolveStarPhrases } from "./noteFlags.js";
import { hasElectronLibrary } from "../services/runtimeBridge.js";

const HIGHWAY_TILT_KEY = "highway.tilt";
const DEFAULT_HIGHWAY_TILT = 1.75;
const MIN_HIGHWAY_TILT = 0.5;
const MAX_HIGHWAY_TILT = 4;

function loadHighwayTilt() {
  try {
    const n = Number(localStorage.getItem(HIGHWAY_TILT_KEY));
    return Number.isFinite(n) && n >= MIN_HIGHWAY_TILT && n <= MAX_HIGHWAY_TILT
      ? n
      : DEFAULT_HIGHWAY_TILT;
  } catch {
    return DEFAULT_HIGHWAY_TILT;
  }
}


function computeBeats(tempoMap, resolution, endTime) {
  const beats = [];
  if (!tempoMap || !resolution) return beats;
  for (let tick = 0; ; tick += resolution) {
    const t = tempoMap.tickToSeconds(tick);
    if (t > endTime + 2) break;
    beats.push(t);
    if (beats.length > 200000) break;
  }
  return beats;
}

function cloneRenderableNotes(track, starPhrases) {
  const notes = (track?.notes || []).map((note, index) => ({
    ...note,
    index,
    frets: Array.isArray(note.frets) ? [...note.frets] : [],
    judged: false,
    result: null,
    ghosted: false,
    sustainDropped: false,
    sustainDropStartedAt: null,
    sustainHoldGraceUntil: 0,
    visualHeld: false,
  }));
  annotateNotes(notes, track?.song?.resolution || 192);
  markStarNotes(notes, starPhrases || []);
  return notes;
}

function prepareRenderState(chart, canvas, index) {
  if (!chart?.track || !canvas) return null;
  const inElectron = hasElectronLibrary();
  const renderer = new HighwayRenderer(canvas, {
    zMax: loadHighwayTilt(),
    effectProfile: inElectron ? "rich" : "lite",
  });
  const starPhrases = resolveStarPhrases(chart.track.starPower, chart.track.tempoMap);
  const notes = cloneRenderableNotes(chart.track, starPhrases);
  const lastTime = notes.length ? notes[notes.length - 1].endTime : 0;
  const beatTimes = computeBeats(chart.track.tempoMap, chart.track.song?.resolution || 192, lastTime);
  renderer.setNotes(notes);
  renderer.setBeatTimes(beatTimes);
  renderer.setStarPhrases(starPhrases);
  renderer.resize();
  return {
    ...chart,
    index,
    track: chart.track,
    compareOffset: Math.max(0, Number(chart.compareOffset) || 0),
    renderer,
    renderNotes: notes,
    beatTimes,
    starPhrases,
    noteCursor: 0,
    lastChartTime: null,
  };
}

function resetRenderNotesForTime(state, chartTime) {
  state.renderer.clearEffects();
  let cursor = 0;
  for (let i = 0; i < state.renderNotes.length; i++) {
    const note = state.renderNotes[i];
    note.judged = false;
    note.result = null;
    note.ghosted = false;
    note.sustainDropped = false;
    note.sustainHoldGraceUntil = 0;
    note.visualHeld = false;
    if (note.time < chartTime) {
      note.judged = true;
      note.result = "perfect";
      note.visualHeld = note.sustain > 0 && note.endTime > chartTime;
      cursor = i + 1;
    }
  }
  state.noteCursor = cursor;
  state.lastChartTime = chartTime;
}

function advanceVisualState(state, chartTime) {
  const jumped =
    state.lastChartTime == null ||
    chartTime < state.lastChartTime - 0.2 ||
    chartTime > state.lastChartTime + 0.75;
  if (jumped) resetRenderNotesForTime(state, chartTime);
  state.lastChartTime = chartTime;
  while (state.noteCursor < state.renderNotes.length) {
    const note = state.renderNotes[state.noteCursor];
    if (note.judged) {
      state.noteCursor += 1;
      continue;
    }
    if (note.time > chartTime) break;
    note.judged = true;
    note.result = "perfect";
    note.visualHeld = note.sustain > 0 && note.endTime > chartTime;
    const lanes = note.open ? [0, 1, 2, 3, 4] : note.frets;
    for (const lane of lanes) state.renderer.flashLane(lane, note.time);
    state.noteCursor += 1;
  }
}

function trackSync(track, audioCtx) {
  const latency = (Number(audioCtx?.baseLatency) || 0) + (Number(audioCtx?.outputLatency) || 0);
  return -latency - (Number(track?.song?.offset) || 0);
}


function createJoinedRendererAdapter(getStates, getEngine) {
  return {
    setNotes(notes) {
      const base = getStates()[0];
      if (base) {
        base.renderNotes = notes;
        base.noteCursor = 0;
        base.lastChartTime = null;
        base.renderer.setNotes(notes);
      }
    },
    setBeatTimes(times) {
      const base = getStates()[0];
      if (base) base.renderer.setBeatTimes(times);
    },
    setStarPhrases(phrases) {
      const base = getStates()[0];
      if (base) base.renderer.setStarPhrases(phrases);
    },
    setReduceMotion(on) {
      for (const state of getStates()) state.renderer.setReduceMotion(on);
    },
    clearEffects() {
      for (const state of getStates()) state.renderer.clearEffects();
    },
    flashLane(lane, songTime) {
      const base = getStates()[0];
      base?.renderer.flashLane?.(lane, songTime);
    },
    resize() {
      for (const state of getStates()) state.renderer.resize();
    },
    draw(baseSongTime = 0) {
      const states = getStates();
      const base = states[0];
      if (!base) return;
      const audioCtx = getEngine()?.audioCtx || null;
      const baseSync = trackSync(base.track, audioCtx);
      const globalTime = baseSongTime + (base.compareOffset || 0);
      const audioPosition = globalTime - baseSync;
      for (const state of states) {
        const chartTime = audioPosition + trackSync(state.track, audioCtx) - (state.compareOffset || 0);
        if (state !== base) advanceVisualState(state, chartTime);
        state.renderer.draw(chartTime);
      }
    },
  };
}

function JoinedHighwayCompare(
  {
    charts = [],
    audioBuffer,
    background,
    muted = false,
    volume = 1,
    className = "",
    initialTime = 0,
    playOnReady = false,
    videoOffset = 0,
    onProgress,
    onPlayingChange,
  },
  ref
) {
  const stageRef = useRef(null);
  const canvasRefs = useRef([]);
  const statesRef = useRef([]);
  const engineRef = useRef(null);
  const adapterRef = useRef(null);
  const videoRef = useRef(null);
  const initialTimeRef = useRef(initialTime);
  const playOnReadyRef = useRef(playOnReady);
  const onProgressRef = useRef(onProgress);
  const onPlayingChangeRef = useRef(onPlayingChange);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState({ time: initialTime, duration: 0 });
  const [error, setError] = useState(null);
  const resolvedVideoOffset = Number.isFinite(Number(videoOffset))
    ? Math.max(0, Number(videoOffset))
    : 0;

  const visibleCharts = charts.slice(0, 4).filter((chart) => chart?.track);
  const chartsKey = useMemo(
    () =>
      visibleCharts
        .map((chart, index) => {
          const track = chart.track;
          return [
            chart.id || index,
            chart.updatedAt || "",
            track?.notes?.length || 0,
            track?.starPower?.length || 0,
            track?.song?.offset || 0,
            track?.song?.resolution || 0,
            chart.compareOffset || 0,
          ].join(":");
        })
        .join("|"),
    [visibleCharts]
  );

  useEffect(() => {
    initialTimeRef.current = initialTime;
  }, [initialTime]);

  useEffect(() => {
    playOnReadyRef.current = playOnReady;
  }, [playOnReady]);


  useEffect(() => {
    engineRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    engineRef.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    onPlayingChangeRef.current = onPlayingChange;
  }, [onPlayingChange]);

  const setPlayingState = useCallback((next) => {
    const active = Boolean(next);
    setPlaying(active);
    onPlayingChangeRef.current?.(active);
  }, []);

  const syncVideo = useCallback((time, play) => {
    const video = videoRef.current;
    if (!video) return;
    const mediaTime = Math.max(0, time - resolvedVideoOffset);
    if (Math.abs(video.currentTime - mediaTime) > 0.3) {
      try {
        video.currentTime = mediaTime;
      } catch {
        // Metadata may not be ready yet.
      }
    }
    if (play && time >= resolvedVideoOffset) video.play().catch(() => {});
    else video.pause();
  }, [resolvedVideoOffset]);

  const stopEngine = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.stop();
    videoRef.current?.pause();
    setPlayingState(false);
  }, [setPlayingState]);

  const redrawCurrent = useCallback(() => {
    adapterRef.current?.resize();
    if (!engineRef.current?.running) adapterRef.current?.draw(engineRef.current?.chartTime || 0);
  }, []);


  const playPreview = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !engine.buffer || engine.running) return;
    await engine.play();
    setPlayingState(true);
    syncVideo(engine.songTime, true);
  }, [setPlayingState, syncVideo]);

  const pausePreview = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.running) engine.pause();
    setPlayingState(false);
    syncVideo(engine.songTime, false);
  }, [setPlayingState, syncVideo]);

  const restartPreview = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !engine.buffer) return;
    const wasRunning = engine.running;
    engine.stop();
    engine.reset();
    adapterRef.current?.draw(engine.chartTime || 0);
    syncVideo(0, false);
    if (wasRunning) {
      await engine.play();
      setPlayingState(true);
      syncVideo(0, true);
    } else {
      setPlayingState(false);
    }
  }, [setPlayingState, syncVideo]);

  const seekPreview = useCallback(
    (value) => {
      const engine = engineRef.current;
      if (!engine || !engine.buffer) return;
      engine.seek(value);
      syncVideo(engine.songTime, engine.running);
    },
    [syncVideo]
  );

  useImperativeHandle(
    ref,
    () => ({
      play: playPreview,
      pause: pausePreview,
      restart: restartPreview,
      seek: seekPreview,
      resize: redrawCurrent,
      isReady: () => ready,
      isPlaying: () => Boolean(engineRef.current?.running),
      getProgress: () => progress,
    }),
    [pausePreview, playPreview, progress, ready, redrawCurrent, restartPreview, seekPreview]
  );

  useEffect(() => {
    let cancelled = false;
    let motionMq = null;
    let onMotionPref = null;
    stopEngine();
    setReady(false);
    setError(null);
    statesRef.current = [];

    if (!visibleCharts.length) return () => {
      cancelled = true;
    };

    if (!audioBuffer) {
      setError("Audio is not loaded for this project.");
      return () => {
        cancelled = true;
      };
    }

    const adapter = createJoinedRendererAdapter(
      () => statesRef.current,
      () => engineRef.current
    );
    const engine = new GameEngine(adapter);
    adapterRef.current = adapter;
    engineRef.current = engine;
    engine.setMuted(muted);
    engine.setVolume(volume);
    engine.onProgress = (time, duration) => {
      const next = { time, duration };
      setProgress(next);
      onProgressRef.current?.(time, duration);
      if (engine.running) syncVideo(time, true);
    };
    engine.onEnded = () => {
      setPlayingState(false);
      syncVideo(engine.songTime, false);
    };

    (async () => {
      try {
        await engine.loadAudio(audioBuffer);
        if (cancelled) return;

        const states = visibleCharts
          .map((chart, index) => prepareRenderState(chart, canvasRefs.current[index], index))
          .filter(Boolean);
        statesRef.current = states;
        if (!states.length) throw new Error("No chart lanes are available for joined compare.");

        motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
        adapter.setReduceMotion(motionMq.matches);
        onMotionPref = () => {
          adapter.setReduceMotion(motionMq.matches);
          if (!engine.running) adapter.draw(engine.chartTime || 0);
        };
        motionMq.addEventListener("change", onMotionPref);

        const baseTrack = states[0].track;
        engine.setTrack(baseTrack);
        engine.setChartTimeOffset(states[0].compareOffset || 0);
        engine.seek(Math.max(0, Math.min(Number(initialTimeRef.current) || 0, engine.duration || 0)));
        setReady(true);
        if (playOnReadyRef.current) await playPreview();
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      }
    })();

    return () => {
      cancelled = true;
      engine.stop();
      if (motionMq && onMotionPref) motionMq.removeEventListener("change", onMotionPref);
      if (engineRef.current === engine) engineRef.current = null;
      if (adapterRef.current === adapter) adapterRef.current = null;
      statesRef.current = [];
    };
  }, [audioBuffer, chartsKey, playPreview, setPlayingState, stopEngine, syncVideo]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let rafId = 0;
    const resize = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        redrawCurrent();
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    window.addEventListener("resize", resize);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [redrawCurrent]);

  useEffect(() => {
    const engine = engineRef.current;
    if (background?.type === "video" && engine) syncVideo(engine.songTime, playing);
  }, [background, playing, syncVideo]);

  useEffect(() => stopEngine, [stopEngine]);

  return (
    <div className={`preview joined-compare-preview${className ? ` ${className}` : ""}`}>
      <div className="highway-wrap preview-stage joined-compare-stage" ref={stageRef}>
        <HighwayBackground background={background} videoRef={videoRef} onVideoReady={() => syncVideo(engineRef.current?.songTime || 0, Boolean(engineRef.current?.running))} />
        <div
          className={`joined-highway-grid joined-highway-grid-${visibleCharts.length || 1}`}
          style={{ "--joined-count": visibleCharts.length || 1 }}
        >
          {visibleCharts.map((chart, index) => (
            <div className="joined-highway-slot" key={`${chart.id || index}-${index}`}>
              <canvas
                ref={(node) => {
                  canvasRefs.current[index] = node;
                }}
                className="joined-highway-canvas"
              />
              <div className="joined-highway-label">
                <span className="compare-badge">{chart.badge || index + 1}</span>
                <span className="joined-highway-name" title={chart.name || "Chart"}>
                  {chart.name || "Chart"}
                </span>
              </div>
            </div>
          ))}
        </div>
        {!visibleCharts.length && <div className="highway-empty">Choose two chart versions to compare.</div>}
        {visibleCharts.length > 0 && !ready && !error && (
          <div className="highway-empty highway-loading">Loading joined compare…</div>
        )}
        {error && <div className="highway-empty play-error">{error}</div>}
      </div>
    </div>
  );
}

export default forwardRef(JoinedHighwayCompare);
