import { useCallback, useEffect, useRef, useState } from "react";
import HighwayPreview from "../../highway/HighwayPreview.jsx";
import useSpaceToPlay from "../../hooks/useSpaceToPlay.js";
import JoinedHighwayCompare from "../../highway/JoinedHighwayCompare.jsx";
import DensityStrip from "../../highway/DensityStrip.jsx";
import { activeLyricPhrase, resolveLyricPhrases } from "../../highway/noteFlags.js";
import { MEDIA_ACCEPT } from "../../services/mediaMetadata.js";
import { dragHasFiles, readDrop, songFoldersFromFileList } from "../../services/droppedItems.js";
import { SongArchiveError } from "../../services/songArchives.js";
import { I } from "../../icons.jsx";
import { GenerationPreviewStage } from "./LiveGeneration.jsx";
import { StemSeparationStage } from "./StageAnimations.jsx";
import {
  COMPARE_LANE_COLORS,
  COMPARE_SLOT_LABELS,
  demucsAuditionKey,
  fmtTime,
  generatorStemSetId,
} from "./useGenerateProject.js";
import { useOwnedFullscreen } from "../../hooks/useOwnedFullscreen.js";

const HIGHWAY_VOLUME_KEY = "highway.volume";
const DEMUCS_STEMS = [
  { id: "other", label: "Guitar / other" },
  { id: "drums", label: "Drums" },
  { id: "bass", label: "Bass" },
  { id: "vocals", label: "Vocals" },
];

// The six-stem models separate with htdemucs_6s: guitar gets its own stem and
// other holds the rest (piano included).
const SIX_STEM_DEMUCS_STEMS = [
  { id: "guitar", label: "Guitar" },
  { id: "other", label: "Other" },
  { id: "drums", label: "Drums" },
  { id: "bass", label: "Bass" },
  { id: "vocals", label: "Vocals" },
];

function demucsStemsFor(generator) {
  return generatorStemSetId(generator) === "htdemucs_6s" ? SIX_STEM_DEMUCS_STEMS : DEMUCS_STEMS;
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

function leadInSilenceSecondsFromVersion(version = null) {
  const msValues = [
    version?.meta?.leadInSilenceMs,
    version?.provenance?.sourceTransform?.leadInSilenceMs,
    version?.settings?.generation?.sourceTransform?.leadInSilenceMs,
  ];
  for (const value of msValues) {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms > 0) return ms / 1000;
  }

  const secondValues = [
    version?.meta?.leadInSilenceSeconds,
    version?.provenance?.sourceTransform?.leadInSilenceSeconds,
    version?.settings?.generation?.sourceTransform?.leadInSilenceSeconds,
  ];
  for (const value of secondValues) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }

  const key =
    version?.meta?.sourceVariantKey ||
    version?.provenance?.sourceTransform?.key ||
    version?.settings?.generation?.sourceTransform?.key ||
    "";
  const keyMs = Number(String(key).match(/lead-in:(\d+)/)?.[1] || 0);
  return Number.isFinite(keyMs) && keyMs > 0 ? keyMs / 1000 : 0;
}

function waveformPeaksFromBuffer(buffer, bucketCount = 260) {
  const channel = buffer?.getChannelData?.(0);
  if (!channel?.length) return [];
  const buckets = Math.max(80, Math.min(bucketCount, Math.floor(channel.length / 600) || bucketCount));
  const peaks = [];
  let max = 0;
  for (let i = 0; i < buckets; i += 1) {
    const start = Math.floor((i * channel.length) / buckets);
    const end = Math.floor(((i + 1) * channel.length) / buckets);
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      const value = Math.abs(channel[j]);
      if (value > peak) peak = value;
    }
    peaks.push(peak);
    if (peak > max) max = peak;
  }
  return max > 0 ? peaks.map((value) => value / max) : peaks;
}

function fallbackWavePeaks(count = 180) {
  return Array.from({ length: count }, (_v, i) => {
    const a = Math.sin(i * 0.23) * 0.28 + Math.sin(i * 0.061) * 0.34;
    return 0.18 + Math.abs(a);
  });
}

function drawWaveform(canvas, peaks, progress = 0, active = false) {
  if (!canvas) return;
  const dark = canvas.closest(".ac-app")?.dataset.theme === "dark";
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const grad = ctx.createLinearGradient(0, 0, width, height);
  if (dark) {
    grad.addColorStop(0, "rgba(146, 163, 211, 0.22)");
    grad.addColorStop(0.55, "rgba(49, 58, 82, 0.72)");
    grad.addColorStop(1, "rgba(64, 77, 107, 0.34)");
  } else {
    grad.addColorStop(0, "rgba(104, 96, 181, 0.16)");
    grad.addColorStop(1, "rgba(232, 155, 111, 0.08)");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const usablePeaks = peaks?.length ? peaks : fallbackWavePeaks();
  const peakCount = usablePeaks.length;
  const mid = height / 2;
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const playedX = width * clampedProgress;
  const playedThrough = clampedProgress * peakCount;

  for (let i = 0; i < peakCount; i += 1) {
    const slotStart = Math.floor((i / peakCount) * width);
    const slotEnd = i === peakCount - 1 ? width : Math.floor(((i + 1) / peakCount) * width);
    const barW = Math.max(1, slotEnd - slotStart - (i < peakCount - 1 ? 1 : 0));
    const isPlayed = active && i < playedThrough;
    const amp = Math.max(0, Math.min(1, usablePeaks[i] || 0));
    if (amp <= 0.002) {
      if (!isPlayed) continue;
      ctx.fillStyle = dark ? "rgba(159, 154, 219, 0.22)" : "rgba(74, 69, 133, 0.22)";
      ctx.fillRect(slotStart, mid - 1, barW, 2);
      continue;
    }
    const barHeight = Math.max(2, amp * (height * 0.74));
    ctx.fillStyle = isPlayed
      ? dark ? "rgba(217, 219, 246, 0.96)" : "rgba(104, 96, 181, 0.95)"
      : dark ? "rgba(159, 154, 219, 0.48)" : "rgba(74, 69, 133, 0.42)";
    ctx.fillRect(slotStart, mid - barHeight / 2, barW, barHeight);
  }

  ctx.fillStyle = active ? (dark ? "#d9dbf6" : "#6860b5") : "rgba(104, 96, 181, 0.55)";
  ctx.fillRect(Math.max(0, Math.round(playedX) - 1), 12, 2, height - 24);
}

function decodeWaveformData(data) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !data) {
    return Promise.resolve({ peaks: fallbackWavePeaks(), duration: 0 });
  }
  const ctx = new AudioContextClass();
  return ctx.decodeAudioData(data.slice(0))
    .then((buffer) => ({ peaks: waveformPeaksFromBuffer(buffer), duration: buffer.duration || 0 }))
    .catch(() => ({ peaks: fallbackWavePeaks(), duration: 0 }))
    .finally(() => ctx.close?.().catch?.(() => {}));
}

function DemucsCompareLane({
  slot,
  lane,
  stems = DEMUCS_STEMS,
  stemSetId = "htdemucs",
  artifacts,
  loadingKey,
  audioRef: setAudioRef,
  volume,
  globalMuted,
  anySolo,
  progress,
  onUpdate,
  onSelect,
  onSeek,
  onToggleMute,
  onToggleSolo,
  onTimeUpdate,
  onEnded,
}) {
  const canvasRef = useRef(null);
  const laneAudioRef = useRef(null);
  const artifact = artifacts.find((item) => item.id === lane.artifactId) || artifacts[0];
  const loaded = lane.audition;
  const loading = Boolean(lane.stem && loadingKey === demucsAuditionKey(artifact?.id, stemSetId, lane.stem));
  const effectivelyMuted = globalMuted || lane.muted || (anySolo && !lane.solo) || volume <= 0;
  const selectedStem = stems.find((stem) => stem.id === lane.stem);

  useEffect(() => {
    drawWaveform(canvasRef.current, lane.peaks, progress, Boolean(loaded));
  }, [lane.peaks, progress, loaded]);

  useEffect(() => {
    if (laneAudioRef.current) laneAudioRef.current.volume = volume;
  }, [volume, loaded?.url]);

  useEffect(() => {
    setAudioRef?.(laneAudioRef.current);
    return () => setAudioRef?.(null);
  }, [setAudioRef, loaded]);

  useEffect(() => {
    const onResize = () => drawWaveform(canvasRef.current, lane.peaks, progress, Boolean(loaded));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [lane.peaks, progress, loaded]);

  return (
    <div className={"demucs-compare-lane" + (loaded ? " loaded" : "") + (effectivelyMuted ? " is-muted" : "") + (lane.solo ? " is-solo" : "")}>
      <div className="demucs-compare-lane-head">
        <span className="compare-badge">{slot}</span>
        <label>
          <span>Separation</span>
          <select
            value={artifact?.id || ""}
            onChange={(e) => {
              const nextArtifact = artifacts.find((item) => item.id === e.target.value) || null;
              onSelect(nextArtifact, lane.stem).catch(() => {});
            }}
            disabled={loading}
          >
            {artifacts.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Stem</span>
          <select
            value={lane.stem}
            onChange={(e) => onSelect(artifact, e.target.value).catch(() => {})}
            disabled={!artifact || loading}
          >
            <option value="">Choose stem…</option>
            {stems.map((stem) => (
              <option key={stem.id} value={stem.id}>{stem.label}</option>
            ))}
          </select>
        </label>
        <button className={"demucs-mix-btn" + (lane.muted ? " active" : "")} onClick={onToggleMute} disabled={!loaded}>
          Mute
        </button>
        <button className={"demucs-mix-btn" + (lane.solo ? " active" : "")} onClick={onToggleSolo} disabled={!loaded}>
          Solo
        </button>
      </div>
      <button className="demucs-compare-wave" onClick={onSeek} disabled={!loaded}>
        <canvas ref={canvasRef} aria-hidden="true" />
        {!loaded && <span>{loading ? `Loading ${selectedStem?.label || "stem"}…` : "Choose a stem to load this lane"}</span>}
      </button>
      {loaded && (
        <audio
          ref={laneAudioRef}
          src={loaded.url}
          muted={effectivelyMuted}
          onLoadedMetadata={(e) => {
            const audioDuration = e.currentTarget.duration || 0;
            onUpdate({ duration: lane.duration || audioDuration });
          }}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
        />
      )}
    </div>
  );
}

function DemucsAuditionStage({ project }) {
  const {
    demucsAudition,
    demucsAuditionLoadingKey,
    demucsArtifacts,
    activeDemucsArtifact,
    auditionDemucsStem,
    loadDemucsStem,
    demucsAuditionMode,
    selectedGenerator,
  } = project;
  const stemChoices = demucsStemsFor(selectedGenerator);
  const stemSetId = generatorStemSetId(selectedGenerator);
  const audioRef = useRef(null);
  const compareAudioRefs = useRef({});
  const compareLanesRef = useRef([]);
  const compareLoadRequestRef = useRef({});
  const canvasRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(loadHighwayVolume);
  const [muted, setMuted] = useState(false);
  const [peaks, setPeaks] = useState([]);
  const [waveStatus, setWaveStatus] = useState("");
  const [compareLanes, setCompareLanes] = useState(() => [
    { id: "A", artifactId: "", stem: "", audition: null, peaks: [], duration: 0, muted: false, solo: false },
    { id: "B", artifactId: "", stem: "", audition: null, peaks: [], duration: 0, muted: false, solo: false },
  ]);
  const auditionMode = demucsAuditionMode || "single";

  const activeArtifact =
    demucsArtifacts.find((artifact) => artifact.id === demucsAudition?.id) ||
    activeDemucsArtifact ||
    demucsArtifacts[0];
  const fallbackCompareArtifactId = activeDemucsArtifact?.id || demucsArtifacts[0]?.id || "";
  const anySolo = compareLanes.some((lane) => lane.audition && lane.solo);
  const compareDuration = Math.max(...compareLanes.map((lane) => lane.duration || 0), 0);
  const activeDuration = auditionMode === "compare" ? compareDuration : duration;
  const progress = duration ? time / duration : 0;
  const compareProgress = compareDuration ? time / compareDuration : 0;

  useEffect(() => {
    compareLanesRef.current = compareLanes;
  }, [compareLanes]);

  useEffect(() => {
    setCompareLanes((current) => current.map((lane) => ({
      ...lane,
      artifactId: lane.artifactId || fallbackCompareArtifactId,
    })));
  }, [fallbackCompareArtifactId]);

  useEffect(() => {
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setPeaks([]);
    if (!demucsAudition?.data) {
      setWaveStatus("");
      return undefined;
    }
    let cancelled = false;
    setWaveStatus("Building waveform…");
    decodeWaveformData(demucsAudition.data)
      .then(({ peaks: nextPeaks, duration: nextDuration }) => {
        if (cancelled) return;
        setPeaks(nextPeaks);
        setDuration(nextDuration);
        setWaveStatus("");
      });
    return () => {
      cancelled = true;
    };
  }, [demucsAudition?.data]);

  useEffect(() => {
    const node = audioRef.current;
    if (!node) return;
    node.volume = volume;
    node.muted = muted || volume <= 0;
  }, [volume, muted, demucsAudition?.url]);

  useEffect(() => {
    if (!demucsAudition?.url) return undefined;
    const timer = setTimeout(() => {
      audioRef.current?.play?.()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    }, 80);
    return () => clearTimeout(timer);
  }, [demucsAudition?.url]);

  useEffect(() => {
    drawWaveform(canvasRef.current, peaks, progress, Boolean(demucsAudition?.url));
  }, [peaks, progress, demucsAudition?.url]);

  useEffect(() => {
    const onResize = () => drawWaveform(canvasRef.current, peaks, progress, Boolean(demucsAudition?.url));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [peaks, progress, demucsAudition?.url]);

  const seekTo = (nextTime) => {
    const maxDuration = activeDuration || 0;
    const safe = Math.max(0, Math.min(maxDuration, nextTime));
    if (auditionMode === "compare") {
      Object.values(compareAudioRefs.current).forEach((node) => {
        if (node) node.currentTime = Math.min(safe, node.duration || safe);
      });
    } else if (audioRef.current) {
      audioRef.current.currentTime = safe;
    }
    setTime(safe);
  };

  const handleWaveSeek = (e) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(duration * pct);
  };

  const togglePlay = async () => {
    if (auditionMode === "compare") {
      const nodes = Object.values(compareAudioRefs.current).filter(Boolean);
      if (!nodes.length) return;
      if (playing) {
        nodes.forEach((node) => node.pause());
        setPlaying(false);
        return;
      }
      try {
        await Promise.all(nodes.map((node) => {
          node.currentTime = Math.min(time, node.duration || time);
          return node.play();
        }));
        setPlaying(true);
      } catch {
        nodes.forEach((node) => node.pause());
        setPlaying(false);
      }
      return;
    }
    const node = audioRef.current;
    if (!node || !demucsAudition?.url) return;
    if (playing) {
      node.pause();
      setPlaying(false);
      return;
    }
    try {
      await node.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  };

  const handleVolume = (e) => {
    const next = Math.max(0, Math.min(1, Number(e.target.value)));
    setVolume(next);
    setMuted(next <= 0);
    try {
      localStorage.setItem(HIGHWAY_VOLUME_KEY, String(next));
    } catch {
      // Ignore storage failures; the current audition still uses the value.
    }
  };

  const handleMute = () => {
    setMuted((current) => !current);
  };

  const updateCompareLane = (laneId, patch) => {
    setCompareLanes((current) => current.map((lane) => {
      if (lane.id !== laneId) return lane;
      const hasArtifactPatch = Object.prototype.hasOwnProperty.call(patch, "artifactId");
      const hasStemPatch = Object.prototype.hasOwnProperty.call(patch, "stem");
      const sourceChanged =
        (hasArtifactPatch && patch.artifactId !== lane.artifactId) ||
        (hasStemPatch && patch.stem !== lane.stem);
      if (sourceChanged && lane.audition?.url) URL.revokeObjectURL(lane.audition.url);
      return {
        ...lane,
        ...patch,
        ...(sourceChanged ? { audition: null, peaks: [], duration: 0 } : {}),
      };
    }));
  };

  const selectCompareLane = async (laneId, artifact, stem) => {
    const nextStem = stem || "";
    const requestId = `${Date.now()}:${Math.random()}`;
    compareLoadRequestRef.current[laneId] = requestId;
    updateCompareLane(laneId, { artifactId: artifact?.id || "", stem: nextStem });
    if (!artifact || !nextStem) return null;
    const currentLane = compareLanesRef.current.find((lane) => lane.id === laneId);
    if (currentLane?.artifactId === artifact.id && currentLane?.stem === nextStem && currentLane?.audition) {
      return currentLane.audition;
    }
    const audition = await loadDemucsStem(artifact, nextStem, { activate: false });
    const { peaks: lanePeaks, duration: laneDuration } = await decodeWaveformData(audition.data);
    if (compareLoadRequestRef.current[laneId] !== requestId) {
      if (audition?.url) URL.revokeObjectURL(audition.url);
      return null;
    }
    setCompareLanes((current) => current.map((lane) => {
      if (lane.id !== laneId) return lane;
      if (lane.audition?.url) URL.revokeObjectURL(lane.audition.url);
      return {
        ...lane,
        artifactId: audition.id,
        stem: nextStem,
        audition,
        peaks: lanePeaks,
        duration: laneDuration,
      };
    }));
    return audition;
  };

  useEffect(() => {
    if (auditionMode === "compare") {
      audioRef.current?.pause?.();
    } else {
      Object.values(compareAudioRefs.current).forEach((node) => node?.pause?.());
    }
    setPlaying(false);
  }, [auditionMode]);

  useEffect(() => () => {
    compareLoadRequestRef.current = {};
    compareLanesRef.current.forEach((lane) => {
      if (lane.audition?.url) URL.revokeObjectURL(lane.audition.url);
    });
  }, []);

  return (
    <div className="demucs-audition-stage">
      {auditionMode === "compare" ? (
        <div className="demucs-compare-stack">
          {compareLanes.map((lane) => {
            const artifact = demucsArtifacts.find((item) => item.id === lane.artifactId) || activeArtifact;
            return (
              <DemucsCompareLane
                key={lane.id}
                slot={lane.id}
                lane={{ ...lane, artifactId: artifact?.id || lane.artifactId }}
                stems={stemChoices}
                stemSetId={stemSetId}
                artifacts={demucsArtifacts}
                loadingKey={demucsAuditionLoadingKey}
                audioRef={(node) => {
                  compareAudioRefs.current[lane.id] = node;
                }}
                volume={volume}
                globalMuted={muted}
                anySolo={anySolo}
                progress={compareProgress}
                onUpdate={(patch) => updateCompareLane(lane.id, patch)}
                onSelect={(selectedArtifact, stem) => selectCompareLane(lane.id, selectedArtifact, stem)}
                onSeek={(e) => {
                  if (!compareDuration) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  seekTo(compareDuration * pct);
                }}
                onToggleMute={() => updateCompareLane(lane.id, { muted: !lane.muted })}
                onToggleSolo={() => updateCompareLane(lane.id, { solo: !lane.solo })}
                onTimeUpdate={(e) => setTime(e.currentTarget.currentTime || 0)}
                onEnded={() => setPlaying(false)}
              />
            );
          })}
        </div>
      ) : (
        <div
          className="demucs-wave-panel"
          onPointerDown={handleWaveSeek}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void togglePlay();
            }
          }}
          role="button"
          tabIndex={0}
        >
          <canvas ref={canvasRef} className="demucs-wave-canvas" aria-hidden="true" />
          {!demucsAudition?.url && (
            <div className="demucs-wave-empty">
              <I.volume />
              <b>Nothing playing</b>
              <span>Pick a stem below to listen.</span>
            </div>
          )}
          {waveStatus && <div className="demucs-wave-status">{waveStatus}</div>}
        </div>
      )}

      <div className="demucs-stage-transport">
        <button className="transport-btn" onClick={togglePlay} disabled={auditionMode === "compare" ? !compareLanes.some((lane) => lane.audition) : !demucsAudition?.url}>
          {playing ? <><I.pause /> Pause</> : <><I.play /> Play</>}
        </button>
        <button className="transport-btn ghost" onClick={() => seekTo(Math.max(0, time - 10))} disabled={!activeDuration}>-10s</button>
        <span className="transport-time">{fmtTime(time)}</span>
        <input
          className="demucs-stage-seek"
          type="range"
          min={0}
          max={activeDuration || 0}
          step={0.05}
          value={Math.min(time, activeDuration || 0)}
          onChange={(e) => seekTo(Number(e.target.value))}
          disabled={!activeDuration}
          aria-label="Audition time"
        />
        <span className="transport-time">{fmtTime(activeDuration)}</span>
        <button className="transport-btn ghost" onClick={() => seekTo(Math.min(activeDuration || 0, time + 10))} disabled={!activeDuration}>+10s</button>
        <div className={"volume-control" + (muted || volume <= 0 ? " is-muted" : "")}>
          <button
            className="volume-mute-btn"
            type="button"
            onClick={handleMute}
            title={muted || volume <= 0 ? "Unmute audition" : "Mute audition"}
            aria-label={muted || volume <= 0 ? "Unmute audition" : "Mute audition"}
            aria-pressed={muted || volume <= 0}
          >
            {muted || volume <= 0 ? <I.volumeMute /> : <I.volume />}
          </button>
          <input
            className="volume-slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={handleVolume}
            aria-label="Audition volume"
          />
        </div>
      </div>

      {auditionMode === "single" && <div className="demucs-stage-stems" aria-label="Audition stems from selected separation">
        {stemChoices.map((stem) => {
          const loading = demucsAuditionLoadingKey === demucsAuditionKey(activeArtifact?.id, stemSetId, stem.id);
          const active = demucsAudition?.id === activeArtifact?.id && demucsAudition?.stem === stem.id &&
            (demucsAudition?.stemSet || "htdemucs") === stemSetId;
          return (
            <button
              key={stem.id}
              className={active ? "active" : ""}
              onClick={() => activeArtifact && auditionDemucsStem(activeArtifact, stem.id).catch(() => {})}
              disabled={!activeArtifact || loading}
            >
              {loading ? <span className="cta-spinner" aria-hidden="true" /> : <I.play />}
              {stem.label}
            </button>
          );
        })}
      </div>}

      {auditionMode === "single" && demucsAudition?.url && (
        <audio
          ref={audioRef}
          src={demucsAudition.url}
          onLoadedMetadata={(e) => {
            const audioDuration = e.currentTarget.duration || 0;
            setDuration((prev) => prev || audioDuration);
          }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime || 0)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}
    </div>
  );
}

export default function PreviewStage({ project, ws, highwayRef, onOpenSongFolders }) {
  const {
    importedSong,
    background,
    baseTrack,
    audioBuffer,
    previewAudioError,
    activeVideoOffset,
    track,
    sourceAudioFile,
    handleMediaFile,
    busy,
    busyAction,
    reportPreviewPlaying,
    showingLiveStage,
    setLiveStageFocused,
    selectedSingleVersion,
    selectedCompareVersions,
    previewMode,
    exitCompare,
    deckTab,
    demucsAudition,
    activeDemucsArtifact,
    workTab,
  } = project;
  // Inpaint and Edit keep this stage, and its highway, mounted: the take
  // swaps for its editable draft in place, so the playhead never moves.
  const editing = workTab !== "generate";
  // Inpaint's compare uses this same compare stage, with the checked
  // versions of regenerated areas in the slots and the song map as transport.
  const regenCompare = editing && Boolean(ws?.comparing);
  const inCompare = regenCompare || previewMode === "compare";
  const compareCount = regenCompare ? ws.compareCharts.length : selectedCompareVersions.length;

  const [dropHot, setDropHot] = useState(false);
  // An empty project also opens Clone Hero song folders, in its own place.
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState("");
  const folderInputRef = useRef(null);
  const canOpenFolders = Boolean(onOpenSongFolders) && !sourceAudioFile && !busy;
  const [compareLayout, setCompareLayout] = useState("joined");
  const [comparePlaying, setComparePlaying] = useState(false);
  const [compareProgress, setCompareProgress] = useState({ time: 0, duration: 0 });
  const compareDuration = compareProgress.duration;
  const [compareVolume, setCompareVolume] = useState(loadHighwayVolume);
  const [compareMuted, setCompareMuted] = useState(false);
  const lastCompareVolumeRef = useRef(compareVolume > 0 ? compareVolume : 1);
  const compareShellRef = useRef(null);
  const joinedCompareRef = useRef(null);
  const comparePreviewRefs = useRef([]);

  // Where the single stage picks up after a compare closes.
  const [handoff, setHandoff] = useState({ time: 0, playing: false });

  useEffect(() => {
    setCompareLayout("joined");
    setComparePlaying(false);
    setCompareProgress({ time: 0, duration: 0 });
    setHandoff({ time: 0, playing: false });
  }, [importedSong]);

  const redrawJoinedCompare = useCallback(() => {
    requestAnimationFrame(() => joinedCompareRef.current?.resize?.());
  }, []);
  const {
    fullscreen: compareFullscreen,
    toggleFullscreen: handleCompareFullscreen,
  } = useOwnedFullscreen({
    targetRef: compareShellRef,
    onResize: redrawJoinedCompare,
    label: "compare",
  });

  const getComparePreviews = () =>
    compareLayout === "joined"
      ? [joinedCompareRef.current].filter(Boolean)
      : comparePreviewRefs.current.slice(0, compareCount).filter(Boolean);

  const pauseCompare = () => {
    getComparePreviews().forEach((preview) => preview.pause?.());
    setComparePlaying(false);
  };

  const handleComparePlay = async () => {
    if (comparePlaying) {
      pauseCompare();
      return;
    }
    await Promise.all(getComparePreviews().map((preview) => preview.play?.()));
    setComparePlaying(true);
  };

  const handleCompareRestart = async () => {
    await Promise.all(getComparePreviews().map((preview) => preview.restart?.()));
    setCompareProgress((p) => ({ ...p, time: 0 }));
  };

  const handleCompareSeek = (value) => {
    getComparePreviews().forEach((preview) => preview.seek?.(value));
    setCompareProgress((p) => ({ ...p, time: value }));
  };

  const handleCompareVolumeChange = (e) => {
    const next = Math.max(0, Math.min(1, Number(e.target.value)));
    setCompareVolume(next);
    if (next > 0) {
      lastCompareVolumeRef.current = next;
      setCompareMuted(false);
    }
    try {
      localStorage.setItem(HIGHWAY_VOLUME_KEY, String(next));
    } catch {
      // Ignore storage failures; the active preview still receives the setting.
    }
  };

  const handleCompareMute = () => {
    const nextVolume = compareMuted || compareVolume <= 0 ? lastCompareVolumeRef.current || 1 : 0;
    if (compareVolume > 0) lastCompareVolumeRef.current = compareVolume;
    setCompareMuted(nextVolume <= 0);
    setCompareVolume(nextVolume);
    try {
      localStorage.setItem(HIGHWAY_VOLUME_KEY, String(nextVolume));
    } catch {
      // Ignore storage failures; the active preview still receives the setting.
    }
  };

  useEffect(() => {
    if (!inCompare) {
      pauseCompare();
      if (compareFullscreen) void handleCompareFullscreen();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCompare, baseTrack]);

  useEffect(() => {
    comparePreviewRefs.current = comparePreviewRefs.current.slice(0, compareCount);
  }, [compareCount]);

  const handleMediaDragOver = (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dropHot) setDropHot(true);
  };

  const handleMediaDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDropHot(false);
  };

  const openSongFolders = async (folders) => {
    setFolderError("");
    setFolderBusy(true);
    try {
      await onOpenSongFolders(folders);
    } catch (error) {
      setFolderError(error?.message || "That folder couldn't be opened.");
    } finally {
      setFolderBusy(false);
    }
  };

  const handleMediaDrop = (e) => {
    e.preventDefault();
    setDropHot(false);
    if (!canOpenFolders) {
      const f = e.dataTransfer?.files?.[0];
      if (f) handleMediaFile(f);
      return;
    }
    if (folderBusy) return;
    readDrop(e.dataTransfer).then(({ folders, directories, archives, file }) => {
      if (folders.length) openSongFolders(folders);
      else if (directories || archives) setFolderError("No Clone Hero song in there. It needs a notes.chart and the song's audio.");
      else if (file) {
        setFolderError("");
        handleMediaFile(file);
      }
    }).catch((err) => setFolderError(err instanceof SongArchiveError ? err.message : "That drop couldn't be read."));
  };

  const handleCompareLayout = (layout) => {
    if (layout === compareLayout) return;
    pauseCompare();
    if (compareFullscreen) void handleCompareFullscreen();
    setCompareLayout(layout);
  };

  // Joined view renders every selected take; the deck checkboxes cap at 4.
  // Inpaint's versions all share the draft's timing, so no offsets.
  const compareVersions = regenCompare ? ws.compareCharts : selectedCompareVersions;
  const joinedCompareVersions = compareVersions;
  const compareLeadInSeconds = regenCompare
    ? 0
    : selectedCompareVersions.reduce((max, version) => Math.max(max, leadInSilenceSecondsFromVersion(version)), 0);
  const compareOffsetForVersion = (version) =>
    regenCompare ? 0 : Math.max(0, compareLeadInSeconds - leadInSilenceSecondsFromVersion(version));

  // On Inpaint the song map, the roll and the loops drive the stage
  // through highwayRef; while comparing, that is every compared highway.
  useEffect(() => {
    if (!regenCompare) return undefined;
    const facade = {
      play: () => Promise.all(getComparePreviews().map((preview) => preview.play?.())),
      pause: () => getComparePreviews().forEach((preview) => preview.pause?.()),
      seek: (time) => getComparePreviews().forEach((preview) => preview.seek?.(time)),
      isPlaying: () => getComparePreviews().some((preview) => preview.isPlaying?.()),
      getProgress: () => getComparePreviews()[0]?.getProgress?.(),
    };
    highwayRef.current = facade;
    return () => {
      if (highwayRef.current === facade) highwayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenCompare, compareLayout]);
  const regenProgress = (time, duration) => {
    setCompareProgress({ time, duration });
    ws.onProgress(time, duration);
  };
  const compareLyricTrack = selectedCompareVersions[0]?.track || baseTrack;
  const compareLyricPhrases =
    previewMode === "compare"
      ? resolveLyricPhrases(compareLyricTrack?.events, compareLyricTrack?.tempoMap)
      : [];
  const compareLyricTime = compareProgress.time - compareOffsetForVersion(selectedCompareVersions[0]);
  const compareLyric = activeLyricPhrase(compareLyricPhrases, compareLyricTime);
  const showingDemucsStage = deckTab === "demucs";
  const showingSinglePreview =
    busyAction !== "separating" &&
    !showingDemucsStage &&
    !showingLiveStage &&
    Boolean(track) &&
    previewMode === "single";

  // Single and compare are different highways. On a swap, read the one going
  // off stage while it is still mounted, so the one coming on starts at the
  // same time, playing or not. Any other stage change starts fresh.
  const stageShown = inCompare ? "compare" : showingSinglePreview ? "single" : "other";
  const [lastStageShown, setLastStageShown] = useState(stageShown);
  if (lastStageShown !== stageShown) {
    setLastStageShown(stageShown);
    const leaving = lastStageShown === "compare"
      ? getComparePreviews()[0]
      : lastStageShown === "single" ? highwayRef.current : null;
    const next = leaving && stageShown !== "other"
      ? { time: leaving.getProgress?.()?.time || 0, playing: Boolean(leaving.isPlaying?.()) }
      : { time: 0, playing: false };
    if (stageShown === "compare") {
      setCompareProgress((p) => ({ ...p, time: next.time }));
      setComparePlaying(next.playing);
    } else {
      setHandoff(next);
    }
  }

  // Space plays or pauses the compared charts together, as the Play button
  // does. (The single preview handles Space itself.)
  const showingCompare =
    busyAction !== "separating" &&
    !showingDemucsStage &&
    !showingLiveStage &&
    Boolean(track) &&
    previewMode === "compare" &&
    !previewAudioError;
  useSpaceToPlay(showingCompare, handleComparePlay);

  // The generate flow reads this to avoid yanking the stage away from an
  // active listen. Whenever the single preview isn't on stage its engine is
  // gone (or it never mounted), so nothing is audibly playing from it — clear
  // the flag here because an unmount never fires onPlayingChange.
  useEffect(() => {
    if (!showingSinglePreview) reportPreviewPlaying?.(false);
    return () => reportPreviewPlaying?.(false);
  }, [showingSinglePreview, reportPreviewPlaying]);

  return (
    <section className="gen-preview-card">
      <div className="gen-panel-head">
        <div className="gen-head-line">
          <div className="gen-head">{showingDemucsStage ? "SEPARATION AUDITION" : "PREVIEW STAGE"}</div>
          {!showingDemucsStage && previewMode === "compare" && compareLyric && (
            <div className="compare-head-lyrics" title={compareLyric.text}>
              {compareLyric.text}
            </div>
          )}
        </div>
        <div className="preview-head-actions">
          {/* Before the take chip, so the chip sits in the same place on every tab. */}
          {editing && <EditStageActions project={project} />}
          {showingDemucsStage && (
            <div className="single-version-head demucs-stage-head-pill">
              <span className="compare-badge">A</span>
              <span className="single-version-name" title={demucsAudition?.label || activeDemucsArtifact?.name || "Audio separation"}>
                {demucsAudition?.label || activeDemucsArtifact?.name || "Audio separation"}
              </span>
            </div>
          )}
          {!showingDemucsStage && track && !inCompare && selectedSingleVersion && (
            <div className="single-version-head">
              <span className="compare-badge">{selectedSingleVersion.badge}</span>
              <span className="single-version-name" title={selectedSingleVersion.name}>
                {selectedSingleVersion.name}
              </span>
            </div>
          )}
          {!showingDemucsStage && track && inCompare && (
            <>
              <div className="compare-layout-tabs" aria-label="Compare layout">
                <button
                  className={compareLayout === "joined" ? "active" : ""}
                  onClick={() => handleCompareLayout("joined")}
                >
                  Joined
                </button>
                <button
                  className={compareLayout === "split" ? "active" : ""}
                  onClick={() => handleCompareLayout("split")}
                >
                  Split
                </button>
              </div>
              <button className="compare-pill" onClick={regenCompare ? ws.toggleCompare : exitCompare}>
                ✕ Close compare
              </button>
            </>
          )}
        </div>
      </div>

      {busyAction === "separating" ? (
        <StemSeparationStage />
      ) : showingDemucsStage ? (
        <DemucsAuditionStage project={project} />
      ) : showingLiveStage || (track && !inCompare) ? (
        <GenerationPreviewStage
          project={project}
          highwayRef={highwayRef}
          editTrack={editing ? ws.previewTrack : null}
          resume={handoff}
          onProgress={editing ? ws.onProgress : undefined}
        />
      ) : !track ? (
        <>
        <input
          ref={folderInputRef}
          type="file"
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={(e) => {
            const folders = songFoldersFromFileList(e.target.files);
            e.target.value = "";
            if (folders.length) openSongFolders(folders);
          }}
        />
        <label
          className={"dropzone" + (!sourceAudioFile ? " is-empty" : "") + (dropHot ? " hot" : "")}
          onDragOver={handleMediaDragOver}
          onDragLeave={handleMediaDragLeave}
          onDrop={handleMediaDrop}
        >
          <input type="file" accept={MEDIA_ACCEPT} onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) handleMediaFile(f);
          }} hidden />
          <div className="dz-illu">
            <svg viewBox="0 0 132 110" fill="none">
              <path
                d="M14 96V44c0-5 4-9 9-9h30l8 9h48c5 0 9 4 9 9v43c0 5-4 9-9 9H23c-5 0-9-4-9-9z"
                fill="var(--purple-bg)"
                stroke="var(--purple)"
                strokeWidth="2.5"
              />
              <rect x="50" y="14" width="40" height="48" rx="6" fill="var(--surface)" stroke="var(--purple)" strokeWidth="2.5" />
              <g
                transform="translate(55 22) scale(1.3)"
                fill="none"
                stroke="var(--purple)"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18V5l11-2v13" />
                <circle cx="6" cy="18" r="3" fill="var(--purple)" stroke="none" />
                <circle cx="17" cy="16" r="3" fill="var(--purple)" stroke="none" />
              </g>
            </svg>
          </div>
          <div className="dz-title">
            {dropHot ? "Drop to import" : sourceAudioFile ? "Media is ready" : "No chart yet"}
          </div>
          <div className={"dz-sub" + (folderError ? " is-error" : "")} role={folderError ? "alert" : undefined}>
            {folderError || (sourceAudioFile
              ? "Generate a chart to preview it."
              : canOpenFolders
                ? "Drop a song, music video or Clone Hero song folder here, or click to browse."
                : "Drop a song or music video here, or click to browse.")}
          </div>
          {!sourceAudioFile && (
            <span className="dz-browse">
              <I.upload /> Choose Media File
            </span>
          )}
          {canOpenFolders && (
            <button
              type="button"
              className="dz-folder"
              disabled={folderBusy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                folderInputRef.current?.click();
              }}
            >
              <I.folder /> {folderBusy ? "Opening…" : "Open a Clone Hero song folder"}
            </button>
          )}
        </label>
        </>
      ) : (
        <div
          className={`compare-shell compare-shell-${compareLayout}${compareFullscreen ? " is-fullscreen" : ""}`}
          ref={compareLayout === "joined" ? compareShellRef : null}
        >
          {previewAudioError ? (
            <div className="preview-audio-error">{previewAudioError}</div>
          ) : compareLayout === "joined" ? (
            <>
              <div className="joined-compare-selectors">
                {joinedCompareVersions.map((version, index) => {
                  const slotLabel = COMPARE_SLOT_LABELS[index] || String(index + 1);
                  return (
                    <div className="joined-version-select" key={`${index}-${version.id}`}>
                      <span className="compare-badge">{slotLabel}</span>
                      <span className="compare-pane-name" title={version.name}>
                        {version.name}
                      </span>
                    </div>
                  );
                })}
              </div>
              <JoinedHighwayCompare
                ref={joinedCompareRef}
                charts={joinedCompareVersions.map((version, index) => ({
                  id: version.id,
                  updatedAt: version.updatedAt,
                  name: version.name,
                  badge: COMPARE_SLOT_LABELS[index] || String(index + 1),
                  track: version.track || baseTrack,
                  compareOffset: compareOffsetForVersion(version),
                }))}
                audioBuffer={audioBuffer}
                videoOffset={activeVideoOffset}
                background={background}
                muted={compareMuted}
                volume={compareVolume}
                initialTime={compareProgress.time}
                playOnReady={comparePlaying}
                className="joined-compare-shell"
                onProgress={regenCompare ? regenProgress : (time, duration) => setCompareProgress({ time, duration })}
                onPlayingChange={regenCompare ? project.setEditorPlaying : undefined}
              />
            </>
          ) : (
            <div className={`compare-grid compare-grid-${compareVersions.length}`}>
              {compareVersions.map((version, index) => {
                const slotLabel = COMPARE_SLOT_LABELS[index] || String(index + 1);
                return (
                  <div className="compare-pane" key={`${index}-${version.id}`}>
                    <div className="compare-pane-head">
                      <span className="compare-badge">{slotLabel}</span>
                      <span className="compare-pane-name" title={version.name}>
                        {version.name}
                      </span>
                    </div>
                    <HighwayPreview
                      ref={(node) => {
                        comparePreviewRefs.current[index] = node;
                      }}
                      track={version.track || baseTrack}
                      compareOffset={compareOffsetForVersion(version)}
                      audioBuffer={audioBuffer}
                      videoOffset={activeVideoOffset}
                      background={background}
                      hideTransport
                      hideControls
                      showLyrics={false}
                      muted={compareMuted || index !== 0}
                      volume={compareVolume}
                      initialTime={compareProgress.time}
                      playOnReady={comparePlaying}
                      className="compare-preview"
                      onProgress={index === 0 ? (regenCompare ? regenProgress : (time, duration) => setCompareProgress({ time, duration })) : undefined}
                      onPlayingChange={regenCompare && index === 0 ? project.setEditorPlaying : undefined}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {!regenCompare && <div className="compare-transport">
            <button className="transport-btn" onClick={handleComparePlay}>
              {comparePlaying ? <><I.pause /> Pause</> : <><I.play /> Play</>}
            </button>
            <button className="transport-btn ghost" onClick={handleCompareRestart} title="Restart all charts">
              ⟲
            </button>
            <span className="transport-time">{fmtTime(compareProgress.time)}</span>
            <div
              className="compare-timeline"
            >
              <DensityStrip
                lanes={(compareLayout === "joined" ? joinedCompareVersions : selectedCompareVersions).map(
                  (version, index) => ({
                    notes: (version.track || baseTrack)?.notes || [],
                    solos: (version.track || baseTrack)?.solos,
                    offset: compareOffsetForVersion(version),
                    color: COMPARE_LANE_COLORS[index % COMPARE_LANE_COLORS.length],
                  })
                )}
                duration={compareDuration}
              />
              <input
                className="seekbar"
                type="range"
                min={0}
                max={compareDuration || 0}
                step={0.05}
                value={Math.min(compareProgress.time, compareDuration || 0)}
                onChange={(e) => handleCompareSeek(Number(e.target.value))}
              />
            </div>
            <span className="transport-time">{fmtTime(compareDuration)}</span>
            <div className={"volume-control" + (compareMuted || compareVolume <= 0 ? " is-muted" : "")}>
              <button
                className="volume-mute-btn"
                type="button"
                onClick={handleCompareMute}
                title={compareMuted || compareVolume <= 0 ? "Unmute chart audio" : "Mute chart audio"}
                aria-label={compareMuted || compareVolume <= 0 ? "Unmute chart audio" : "Mute chart audio"}
                aria-pressed={compareMuted || compareVolume <= 0}
              >
                {compareMuted || compareVolume <= 0 ? <I.volumeMute /> : <I.volume />}
              </button>
              <input
                className="volume-slider"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={compareVolume}
                onChange={handleCompareVolumeChange}
                aria-label="Volume"
              />
            </div>
            {compareLayout === "joined" && (
              <button className="transport-btn ghost" onClick={handleCompareFullscreen}>
                {compareFullscreen ? "⤢ Exit" : "⛶ Full screen"}
              </button>
            )}
        </div>}
        </div>
      )}
    </section>
  );
}

function EditStageActions({ project }) {
  const { editor } = project;
  const saveLabel = editor.dirty ? "Saving…" : editor.savedAt ? "Saved" : "";
  return (
    <span className="stage-edit-meta">
      {editor.draftVersion && editor.sourceVersion && <span>from {editor.sourceVersion.name}</span>}
      {saveLabel && <span className={editor.dirty ? "busy" : ""}>{saveLabel}</span>}
    </span>
  );
}
