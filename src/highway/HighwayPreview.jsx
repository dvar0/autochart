import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { HighwayRenderer } from "./HighwayRenderer.js";
import { GameEngine } from "./GameEngine.js";
import {
  activeLyricPhrase,
  annotateNotes,
  resolveLyricPhrases,
  resolveStarPhrases,
  markStarNotes,
} from "./noteFlags.js";
import DensityStrip from "./DensityStrip.jsx";
import HighwayBackground from "./HighwayBackground.jsx";
import { I } from "../icons.jsx";
import { useOwnedFullscreen } from "../hooks/useOwnedFullscreen.js";
import { hasElectronLibrary } from "../services/runtimeBridge.js";

const HIGHWAY_TILT_KEY = "highway.tilt";
const HIGHWAY_LYRICS_KEY = "highway.lyrics";
const HIGHWAY_VOLUME_KEY = "highway.volume";
const DEFAULT_HIGHWAY_TILT = 1.75;
const MIN_HIGHWAY_TILT = 0.5;
const MAX_HIGHWAY_TILT = 4;
const HIGHWAY_TILT_STEP = 0.25;

function loadHighwayTilt() {
  try {
    const n = Number(localStorage.getItem(HIGHWAY_TILT_KEY));
    return Number.isFinite(n) && n >= MIN_HIGHWAY_TILT && n <= MAX_HIGHWAY_TILT ? n : DEFAULT_HIGHWAY_TILT;
  } catch {
    return DEFAULT_HIGHWAY_TILT;
  }
}
function loadShowLyrics() {
  try {
    const value = localStorage.getItem(HIGHWAY_LYRICS_KEY);
    return value === null ? true : value === "true";
  } catch {
    return true;
  }
}
function loadHighwayVolume() {
  try {
    const raw = localStorage.getItem(HIGHWAY_VOLUME_KEY);
    if (raw === null) return 1;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
  } catch {
    return 1;
  }
}
function clampHighwayTilt(n) {
  return Math.round(Math.max(MIN_HIGHWAY_TILT, Math.min(MAX_HIGHWAY_TILT, n)) * 100) / 100;
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
function fmtTime(seconds) {
  let value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) value = 0;
  const minutes = Math.floor(value / 60);
  const secondsPart = Math.floor(value % 60);
  return `${minutes}:${String(secondsPart).padStart(2, "0")}`;
}
function lyricWordParts(phrase) {
  const words = phrase?.words || [];
  return words.map((word, index) => ({
    key: `${word.tick}-${index}-${word.text}`,
    text: word.text,
    sep: index > 0 && !words[index - 1].text.endsWith("-") ? " " : "",
    active: index === phrase.currentWordIndex,
  }));
}

/** Visual chart highway; intentionally has no playable instrument input. */
function HighwayPreview(
  {
    track,
    audioBuffer,
    background,
    muted = false,
    volume: volumeProp,
    hideTransport = false,
    hideControls = false,
    visualOnly = false,
    className = "",
    initialTime = 0,
    followTime = null,
    smoothFollow = true,
    playOnReady = false,
    showLyrics = true,
    compareOffset = 0,
    videoOffset = 0,
    audioLeadInSeconds = 0,
    onProgress,
    onPlayingChange,
  },
  ref
) {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const engineRef = useRef(null);
  const videoRef = useRef(null);
  const previewRef = useRef(null);
  const initialTimeRef = useRef(initialTime);
  const playOnReadyRef = useRef(playOnReady);
  const onProgressRef = useRef(onProgress);
  const onPlayingChangeRef = useRef(onPlayingChange);
  const latestTrackRef = useRef(track);
  const audioReadyRef = useRef(false);
  const resolvedCompareOffsetRef = useRef(0);
  const followRafRef = useRef(0);
  const loadedAudioLeadRef = useRef(0);
  const videoOffsetRef = useRef(0);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState({ time: 0, duration: 0 });
  const [lyricPhrases, setLyricPhrases] = useState([]);
  const [error, setError] = useState(null);
  const [tilt, setTilt] = useState(loadHighwayTilt);
  const [lyricsEnabled, setLyricsEnabled] = useState(loadShowLyrics);
  const [volume, setVolume] = useState(() => volumeProp !== undefined ? volumeProp : loadHighwayVolume());
  const [localMuted, setLocalMuted] = useState(false);
  const [highwayPanel, setHighwayPanel] = useState(false);
  const lastVolumeRef = useRef(volume > 0 ? volume : 1);
  const resolvedCompareOffset = Number.isFinite(Number(compareOffset)) ? Number(compareOffset) : 0;
  const resolvedVideoOffset = Number.isFinite(Number(videoOffset)) ? Math.max(0, Number(videoOffset)) : 0;
  // Saved timing metadata can change without replacing the playback engine.
  videoOffsetRef.current = resolvedVideoOffset;

  useEffect(() => { initialTimeRef.current = initialTime; }, [initialTime]);
  useEffect(() => { playOnReadyRef.current = playOnReady; }, [playOnReady]);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);
  useEffect(() => { onPlayingChangeRef.current = onPlayingChange; }, [onPlayingChange]);

  const setPlayingState = useCallback((next) => {
    const active = Boolean(next);
    setPlaying(active);
    onPlayingChangeRef.current?.(active);
  }, []);
  const syncVideo = useCallback((time, shouldPlay) => {
    const video = videoRef.current;
    if (!video) return;
    const mediaTime = Math.max(0, time - videoOffsetRef.current);
    if (Math.abs(video.currentTime - mediaTime) > 0.3) {
      try { video.currentTime = mediaTime; } catch { /* metadata not ready */ }
    }
    if (shouldPlay && time >= videoOffsetRef.current) video.play().catch(() => {});
    else video.pause();
  }, []);
  const resizePreview = useCallback(() => {
    const renderer = rendererRef.current;
    const engine = engineRef.current;
    if (!renderer) return;
    requestAnimationFrame(() => {
      renderer.resize();
      if (!engine?.running) renderer.draw(engine?.chartTime || 0);
    });
  }, []);
  const { fullscreen, toggleFullscreen } = useOwnedFullscreen({ targetRef: previewRef, onResize: resizePreview, label: "highway" });

  useEffect(() => {
    const node = previewRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    let rafId = 0;
    const resize = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => { rafId = 0; resizePreview(); });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    window.addEventListener("resize", resize);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [resizePreview]);

  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const inElectron = hasElectronLibrary();
    const renderer = new HighwayRenderer(canvasRef.current, { zMax: tilt, effectProfile: inElectron ? "rich" : "lite" });
    const engine = new GameEngine(renderer);
    const motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    renderer.setReduceMotion(motionMq.matches);
    const onMotionPref = () => {
      renderer.setReduceMotion(motionMq.matches);
      if (!engine.running) renderer.draw(engine.chartTime || 0);
    };
    motionMq.addEventListener("change", onMotionPref);
    engine.onProgress = (time, duration) => {
      setProgress({ time, duration });
      onProgressRef.current?.(time, duration);
      if (engine.running) syncVideo(time, true);
    };
    engine.onEnded = () => {
      setPlayingState(false);
      syncVideo(engine.songTime, false);
    };
    engine.setVolume(volumeProp !== undefined ? volumeProp : volume);
    engine.setMuted(muted || localMuted);
    rendererRef.current = renderer;
    engineRef.current = engine;
    if (import.meta.env.DEV) window.__highway = { engine, renderer };
    renderer.draw(0);
    window.addEventListener("resize", resizePreview);
    return () => {
      window.removeEventListener("resize", resizePreview);
      motionMq.removeEventListener("change", onMotionPref);
      engine.dispose();
    };
  }, [resizePreview, setPlayingState, syncVideo]);

  useEffect(() => { engineRef.current?.setMuted(muted || localMuted); }, [localMuted, muted]);
  useEffect(() => {
    if (volumeProp !== undefined) engineRef.current?.setVolume(volumeProp);
    else engineRef.current?.setVolume(volume);
  }, [volume, volumeProp]);
  useEffect(() => {
    resolvedCompareOffsetRef.current = resolvedCompareOffset;
    engineRef.current?.setChartTimeOffset(resolvedCompareOffset);
  }, [resolvedCompareOffset]);

  const applyTrack = useCallback((nextTrack, { preserveTime = false, time = initialTimeRef.current } = {}) => {
    const engine = engineRef.current;
    const renderer = rendererRef.current;
    if (!engine || !renderer || !nextTrack) return;
    const phrases = resolveStarPhrases(nextTrack.starPower, nextTrack.tempoMap);
    setLyricPhrases(resolveLyricPhrases(nextTrack.events, nextTrack.tempoMap));
    annotateNotes(nextTrack.notes, nextTrack.song.resolution);
    markStarNotes(nextTrack.notes, phrases);
    const wasRunning = engine.running;
    const previousTime = preserveTime ? engine.songTime || engine.pausedSongTime || 0 : 0;
    engine.setTrack(nextTrack);
    engine.setChartTimeOffset(resolvedCompareOffsetRef.current);
    const lastTime = nextTrack.notes.length ? nextTrack.notes[nextTrack.notes.length - 1].endTime : 0;
    renderer.setBeatTimes(computeBeats(nextTrack.tempoMap, nextTrack.song.resolution, lastTime));
    renderer.setStarPhrases(phrases);
    renderer.setSoloPhrases(nextTrack.solos || []);
    renderer.resize();
    const startAt = preserveTime ? Math.max(0, Math.min(previousTime, engine.duration || 0)) : Math.max(0, Math.min(Number(time) || 0, engine.duration || 0));
    if (!preserveTime || startAt !== previousTime) {
      engine.seek(startAt);
      setProgress({ time: startAt, duration: engine.duration });
      onProgressRef.current?.(startAt, engine.duration);
    } else if (!engine.running) renderer.draw(engine.chartTime);
    if (preserveTime && wasRunning && !engine.running) engine.play().then(() => syncVideo(engine.songTime, true)).catch(() => {});
  }, [syncVideo]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !audioBuffer) {
      return undefined;
    }
    let cancelled = false;
    if (!audioReadyRef.current) setReady(false);
    setError(null);
    (async () => {
      try {
        // Decode in the background. The current audio keeps playing, and an
        // obsolete decode must never overwrite a newer buffer.
        const decoded = await engine.decodeAudio(audioBuffer);
        if (cancelled) return;
        const replacingAudio = audioReadyRef.current;
        const shouldPlay = replacingAudio ? engine.running : playOnReadyRef.current;
        const time = replacingAudio
          ? engine.songTime - loadedAudioLeadRef.current + (Number(audioLeadInSeconds) || 0)
          : initialTimeRef.current;
        if (engine.running) engine.pause();
        engine.buffer = decoded;
        loadedAudioLeadRef.current = Number(audioLeadInSeconds) || 0;
        audioReadyRef.current = true;
        const nextTrack = latestTrackRef.current;
        if (!nextTrack) return;
        applyTrack(nextTrack, { time });
        setReady(true);
        // Completion during decode stays at EOF; play() would restart it.
        if (shouldPlay && engine.songTime < engine.duration) {
          await engine.play();
          if (cancelled) return;
          setPlayingState(true);
          syncVideo(engine.songTime, true);
        } else setPlayingState(false);
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [audioBuffer, audioLeadInSeconds, applyTrack, setPlayingState, syncVideo]);

  useEffect(() => {
    latestTrackRef.current = track;
    if (!track) { setLyricPhrases([]); return; }
    if (!engineRef.current || (!audioReadyRef.current && !visualOnly)) return;
    applyTrack(track, { preserveTime: visualOnly || audioReadyRef.current });
    setReady(true);
  }, [track, applyTrack, visualOnly]);

  useEffect(() => {
    if (!visualOnly || followTime == null || !ready) return undefined;
    const engine = engineRef.current;
    if (!engine) return undefined;
    const target = Math.max(0, Number(followTime) || 0);
    const from = Math.max(0, engine.running ? engine.songTime : engine.pausedSongTime || 0);
    const distance = target - from;
    if (followRafRef.current) cancelAnimationFrame(followRafRef.current);
    followRafRef.current = 0;
    if (!smoothFollow || Math.abs(distance) < 0.04) {
      engine.seek(target);
      return undefined;
    }
    const startedAt = performance.now();
    const durationMs = Math.min(1180, Math.max(340, Math.abs(distance) * 155));
    const step = (now) => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      engine.seek(from + distance * (1 - Math.pow(1 - t, 3)));
      if (t < 1) followRafRef.current = requestAnimationFrame(step);
      else followRafRef.current = 0;
    };
    followRafRef.current = requestAnimationFrame(step);
    return () => {
      if (followRafRef.current) cancelAnimationFrame(followRafRef.current);
      followRafRef.current = 0;
    };
  }, [followTime, ready, smoothFollow, visualOnly]);

  const playPreview = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !ready || engine.running) return;
    await engine.play();
    setPlayingState(true);
    syncVideo(engine.songTime, true);
  }, [ready, setPlayingState, syncVideo]);
  const pausePreview = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !engine.running) return;
    engine.pause();
    setPlayingState(false);
    videoRef.current?.pause();
  }, [setPlayingState]);
  const restartPreview = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !ready) return;
    const wasRunning = engine.running;
    engine.stop();
    engine.reset();
    setProgress({ time: 0, duration: engine.duration });
    onProgressRef.current?.(0, engine.duration);
    if (videoRef.current) videoRef.current.currentTime = 0;
    if (wasRunning) {
      await engine.play();
      setPlayingState(true);
      syncVideo(0, true);
    } else setPlayingState(false);
  }, [ready, setPlayingState, syncVideo]);
  const seekPreview = useCallback((value) => {
    const engine = engineRef.current;
    if (!engine || !ready) return;
    engine.seek(value);
    setProgress({ time: value, duration: engine.duration });
    onProgressRef.current?.(value, engine.duration);
    syncVideo(value, engine.running);
  }, [ready, syncVideo]);

  const toggleLyrics = useCallback(() => {
    setLyricsEnabled((previous) => {
      const next = !previous;
      try { localStorage.setItem(HIGHWAY_LYRICS_KEY, String(next)); } catch { /* browser storage unavailable */ }
      return next;
    });
  }, []);
  const handleVolumeChange = useCallback((event) => {
    if (volumeProp !== undefined) return;
    const next = Math.max(0, Math.min(1, Number(event.target.value)));
    setVolume(next);
    if (next > 0) { lastVolumeRef.current = next; setLocalMuted(false); }
    try { localStorage.setItem(HIGHWAY_VOLUME_KEY, String(next)); } catch { /* browser storage unavailable */ }
    engineRef.current?.setVolume(next);
  }, [volumeProp]);
  const handleMuteToggle = useCallback(() => {
    if (volumeProp !== undefined) return;
    const nextVolume = localMuted || volume <= 0 ? lastVolumeRef.current || 1 : 0;
    if (volume > 0) lastVolumeRef.current = volume;
    setLocalMuted(nextVolume <= 0);
    setVolume(nextVolume);
    try { localStorage.setItem(HIGHWAY_VOLUME_KEY, String(nextVolume)); } catch { /* browser storage unavailable */ }
    engineRef.current?.setVolume(nextVolume);
  }, [localMuted, volume, volumeProp]);
  const setHighwayTilt = useCallback((value) => {
    const next = clampHighwayTilt(value);
    setTilt(next);
    try { localStorage.setItem(HIGHWAY_TILT_KEY, String(next)); } catch { /* browser storage unavailable */ }
    const renderer = rendererRef.current;
    if (renderer) {
      renderer.setPerspective(next);
      const engine = engineRef.current;
      if (!engine?.running) renderer.draw(engine?.chartTime || 0);
    }
  }, []);
  const adjustHighwayTilt = useCallback((delta) => setHighwayTilt(tilt + delta), [setHighwayTilt, tilt]);
  const handleFullscreenToggle = useCallback(() => {
    setHighwayPanel(false);
    toggleFullscreen();
  }, [toggleFullscreen]);

  useImperativeHandle(ref, () => ({
    play: playPreview,
    pause: pausePreview,
    restart: restartPreview,
    seek: seekPreview,
    resize: resizePreview,
    isReady: () => ready,
    isPlaying: () => Boolean(engineRef.current?.running),
    getProgress: () => progress,
  }), [pausePreview, playPreview, progress, ready, restartPreview, seekPreview, resizePreview]);

  useEffect(() => { if (background?.type === "video") syncVideo(progress.time, playing); }, [background, playing, progress.time, resolvedVideoOffset, syncVideo]);
  useEffect(() => () => { if (followRafRef.current) cancelAnimationFrame(followRafRef.current); }, []);

  const activeLyric = showLyrics && lyricsEnabled ? activeLyricPhrase(lyricPhrases, progress.time) : null;
  const activeLyricWords = lyricWordParts(activeLyric);
  const mutedState = localMuted || volume <= 0;

  return (
    <div className={"preview" + (fullscreen ? " is-fullscreen" : "") + (className ? ` ${className}` : "")} ref={previewRef}>
      <div className="highway-wrap preview-stage">
        <HighwayBackground background={background} videoRef={videoRef} onVideoReady={() => syncVideo(engineRef.current?.songTime || 0, Boolean(engineRef.current?.running))} />
        <canvas ref={canvasRef} className="highway-canvas" />
        {activeLyric && activeLyricWords.length > 0 && <div className="highway-lyrics" aria-live="polite">{activeLyricWords.map((word) => <span key={word.key} className={word.active ? "highway-lyric-word active" : "highway-lyric-word"}>{word.sep}{word.text}</span>)}</div>}
        {!track && <div className="highway-empty">Import a song to preview the chart.</div>}
        {track && !ready && !error && !visualOnly && <div className="highway-empty highway-loading">Loading chart…</div>}
        {error && <div className="highway-empty play-error" role="alert">{error}</div>}
      </div>
      {!hideTransport && <div className="transport">
        <button className="transport-btn" onClick={playing ? pausePreview : playPreview} disabled={!ready}>{playing ? <><I.pause aria-hidden="true" /> Pause</> : <><I.play aria-hidden="true" /> Play</>}</button>
        <button className="transport-btn ghost" onClick={restartPreview} disabled={!ready} title="Restart from the beginning" aria-label="Restart from the beginning">⟲</button>
        <span className="transport-time">{fmtTime(progress.time)}</span>
        <div className="timeline"><DensityStrip lanes={track ? [{ notes: track.notes }] : []} duration={progress.duration || 0} /><input className="seekbar" type="range" min={0} max={progress.duration || 0} step={0.05} value={Math.min(progress.time, progress.duration || 0)} onChange={(event) => seekPreview(Number(event.target.value))} disabled={!ready} aria-label="Preview position" /></div>
        <span className="transport-time">{fmtTime(progress.duration)}</span>
        {volumeProp === undefined && <div className={"volume-control" + (mutedState ? " is-muted" : "")}><button className="volume-mute-btn" type="button" onClick={handleMuteToggle} title={mutedState ? "Unmute chart audio" : "Mute chart audio"} aria-label={mutedState ? "Unmute chart audio" : "Mute chart audio"} aria-pressed={mutedState}>{mutedState ? <I.volumeMute aria-hidden="true" /> : <I.volume aria-hidden="true" />}</button><input className="volume-slider" type="range" min={0} max={1} step={0.01} value={volume} onChange={handleVolumeChange} aria-label="Volume" /></div>}
        {!hideControls && <div className="highway-menu">
          <button type="button" className="transport-btn ghost highway-toggle" onClick={() => setHighwayPanel((open) => !open)} title="Adjust visual highway settings" aria-expanded={highwayPanel} aria-controls="highway-settings-panel">Highway</button>
          {highwayPanel && <div className="highway-settings-panel" id="highway-settings-panel"><div className="settings-title">Highway settings</div><div className="settings-row"><div><div className="settings-label">Tilt</div><div className="settings-hint">Lower is flatter. Higher is steeper.</div></div><div className="calib"><button type="button" onClick={() => adjustHighwayTilt(-HIGHWAY_TILT_STEP)} aria-label="Decrease highway tilt">−</button><span className="calib-val">{tilt.toFixed(2)}</span><button type="button" onClick={() => adjustHighwayTilt(HIGHWAY_TILT_STEP)} aria-label="Increase highway tilt">+</button></div></div><div className="settings-row"><div><div className="settings-label">Lyrics</div><div className="settings-hint">Show lyric events from the chart.</div></div><button type="button" className={"visual-toggle" + (lyricsEnabled ? " on" : "")} onClick={toggleLyrics} aria-pressed={lyricsEnabled}>{lyricsEnabled ? "On" : "Off"}</button></div></div>}
        </div>}
        <button className="transport-btn ghost" onClick={handleFullscreenToggle} title={fullscreen ? "Exit full screen" : "Full screen"} aria-label={fullscreen ? "Exit full screen" : "Full screen"}>{fullscreen ? "⤢ Exit" : "⛶ Full screen"}</button>
      </div>}
    </div>
  );
}

export default forwardRef(HighwayPreview);
