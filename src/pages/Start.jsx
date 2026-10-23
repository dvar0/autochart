import { useEffect, useRef, useState } from "react";
import { I } from "../icons.jsx";
import { FRET_COLORS } from "../data/notePalette.js";
import { MODEL_FAMILIES } from "../data/modelFamilies.js";
import { MEDIA_ACCEPT } from "../services/mediaMetadata.js";
import { importSongFolder } from "../services/songImport.js";
import { getSongRecord, recordFromImport, recordToImported, saveSongRecord } from "../services/songLibrary.js";
import { electronHardware, electronModelSetup } from "../services/runtimeBridge.js";

// The browser version's home: where a project starts. There is no library on
// the web, so this page is the way in: a new song, or a Clone Hero song folder
// to keep working on. The list below says what a run needs (the model, a
// capable device) before the user commits to one.

const FAMILY = MODEL_FAMILIES.find((family) => family.id === "fretformer-2");
const DESKTOP_APP_URL = "https://github.com/dvar0/autochart/releases";
const FORMATS = ["MP3", "OGG", "WAV", "FLAC", "M4A", "MP4", "WEBM"];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

// ---------- the highway illustration ----------

// A looping little riff: lane (0-4) and beat. Chords share a beat.
const RIFF = [
  [0, 0], [1, 1], [2, 2], [1, 3], [0, 4], [2, 4.5], [3, 5], [4, 6], [3, 6.5], [2, 7],
  [0, 8], [2, 8], [1, 9], [3, 9], [2, 10], [4, 10], [3, 11], [1, 11.5], [0, 12], [2, 13], [4, 14], [1, 14.5], [3, 15],
];
const RIFF_BEATS = 16;
const BEAT_SECONDS = 0.34;
const TRAVEL_BEATS = 5; // how long a gem takes from the horizon to the strikeline

const TOP_Y = 18;
const STRIKE_Y = 214;
const BOTTOM_Y = 252;
const TOP_HALF = 46;
const BOTTOM_HALF = 150;
const CX = 160;

function halfWidthAt(y) {
  return TOP_HALF + ((BOTTOM_HALF - TOP_HALF) * (y - TOP_Y)) / (BOTTOM_Y - TOP_Y);
}

function laneX(lane, y) {
  const half = halfWidthAt(y);
  return CX - half + ((lane + 0.5) * 2 * half) / 5;
}

// 0 at the horizon, 1 at the strikeline; eased so gems speed up as they near.
function yAt(progress) {
  return TOP_Y + (STRIKE_Y - TOP_Y) * (progress * 0.55 + progress * progress * 0.45);
}

function StartHighway({ hot }) {
  const gemRefs = useRef([]);
  const ringRefs = useRef([]);
  const [still] = useState(() => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const copies = 2;

  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const place = (now) => {
      const beat = ((now - start) / 1000) / BEAT_SECONDS;
      const lit = [0, 0, 0, 0, 0];
      RIFF.forEach(([lane, at], index) => {
        for (let copy = 0; copy < copies; copy += 1) {
          const node = gemRefs.current[index * copies + copy];
          if (!node) continue;
          const loopBeat = (beat % RIFF_BEATS) + copy * RIFF_BEATS;
          const progress = 1 - (at + RIFF_BEATS - loopBeat) / TRAVEL_BEATS;
          if (progress < 0 || progress > 1.18) {
            node.setAttribute("opacity", "0");
            continue;
          }
          const y = yAt(progress);
          const scale = 0.42 + 0.58 * Math.min(1.1, (y - TOP_Y) / (STRIKE_Y - TOP_Y));
          node.setAttribute("transform", `translate(${laneX(lane, y).toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(3)})`);
          node.setAttribute("opacity", progress > 1 ? String(Math.max(0, 1 - (progress - 1) / 0.18)) : progress < 0.08 ? String(progress / 0.08) : "1");
          if (progress > 0.97 && progress < 1.08) lit[lane] = 1;
        }
      });
      ringRefs.current.forEach((ring, lane) => ring?.classList.toggle("is-lit", Boolean(lit[lane])));
      frame = requestAnimationFrame(place);
    };
    if (still) {
      place(start + BEAT_SECONDS * 1000 * 3.4);
      cancelAnimationFrame(frame);
      return undefined;
    }
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [still]);

  const lanes = [0, 1, 2, 3, 4];
  const road = `M${CX - TOP_HALF} ${TOP_Y} L${CX + TOP_HALF} ${TOP_Y} L${CX + BOTTOM_HALF} ${BOTTOM_Y} L${CX - BOTTOM_HALF} ${BOTTOM_Y} Z`;
  return (
    <svg className={"start-highway" + (hot ? " is-hot" : "")} viewBox="0 0 320 252" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <defs>
        <linearGradient id="start-road" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--start-road-far)" />
          <stop offset="1" stopColor="var(--start-road-near)" />
        </linearGradient>
        <clipPath id="start-road-clip"><path d={road} /></clipPath>
      </defs>
      <path d={road} fill="url(#start-road)" />
      <g clipPath="url(#start-road-clip)">
        {[1, 2, 3, 4].map((i) => (
          <line
            key={i}
            x1={CX - TOP_HALF + (i * 2 * TOP_HALF) / 5}
            y1={TOP_Y}
            x2={CX - BOTTOM_HALF + (i * 2 * BOTTOM_HALF) / 5}
            y2={BOTTOM_Y}
            className="start-lane-line"
          />
        ))}
        {[0.18, 0.4, 0.62, 0.84].map((p) => {
          const y = yAt(p);
          return <line key={p} x1={CX - halfWidthAt(y)} x2={CX + halfWidthAt(y)} y1={y} y2={y} className="start-beat-line" />;
        })}
      </g>
      <path d={`M${CX - TOP_HALF} ${TOP_Y} L${CX - BOTTOM_HALF} ${BOTTOM_Y}`} className="start-road-edge" />
      <path d={`M${CX + TOP_HALF} ${TOP_Y} L${CX + BOTTOM_HALF} ${BOTTOM_Y}`} className="start-road-edge" />
      {lanes.map((lane) => (
        <g
          key={lane}
          ref={(node) => { ringRefs.current[lane] = node; }}
          className="start-ring"
          transform={`translate(${laneX(lane, STRIKE_Y)} ${STRIKE_Y})`}
          style={{ "--gem": FRET_COLORS[lane] }}
        >
          <ellipse rx="22" ry="11" className="start-ring-glow" />
          <ellipse rx="17" ry="8.5" className="start-ring-outer" />
          <ellipse rx="10" ry="4.8" className="start-ring-inner" />
        </g>
      ))}
      {RIFF.flatMap(([lane], index) => Array.from({ length: copies }, (_, copy) => (
        <g
          key={`${index}-${copy}`}
          ref={(node) => { gemRefs.current[index * copies + copy] = node; }}
          opacity="0"
          style={{ "--gem": FRET_COLORS[lane] }}
        >
          <ellipse cy="3" rx="17" ry="8.5" className="start-gem-base" />
          <ellipse rx="17" ry="8.5" className="start-gem" />
          <ellipse rx="9" ry="3.6" cy="-1" className="start-gem-cap" />
        </g>
      )))}
    </svg>
  );
}

// ---------- readiness ----------

function useModelState() {
  const [state, setState] = useState({ phase: "checking", percent: 0, error: "" });

  useEffect(() => {
    const setup = electronModelSetup();
    if (!setup) {
      setState({ phase: "unavailable", percent: 0, error: "" });
      return undefined;
    }
    let active = true;
    setup.scan().then((result) => {
      if (!active) return;
      const status = result?.generatorReadiness?.[FAMILY.generatorId];
      setState({
        phase: !status || status.status === "unsupported" ? "unavailable" : status.downloaded ? "ready" : status.status === "partial" ? "partial" : "missing",
        percent: 0,
        error: "",
      });
    }).catch(() => active && setState({ phase: "unavailable", percent: 0, error: "" }));
    const off = setup.onInstallEvent?.((event) => {
      if (!active || event.phase !== "downloading") return;
      setState((current) => ({ ...current, phase: "downloading", percent: event.percent || 0 }));
    });
    return () => {
      active = false;
      off?.();
    };
  }, []);

  const download = async () => {
    const setup = electronModelSetup();
    if (!setup) return;
    setState({ phase: "downloading", percent: 0, error: "" });
    try {
      await setup.install();
      setState({ phase: "ready", percent: 100, error: "" });
    } catch (error) {
      setState({ phase: "missing", percent: 0, error: error?.message || "The download failed." });
    }
  };

  return { ...state, download };
}

function useDeviceState() {
  const [device, setDevice] = useState({ checked: false, webgpu: false, gpu: "", memoryGb: null, freeBytes: null });

  useEffect(() => {
    let active = true;
    Promise.all([
      electronHardware()?.probe().catch(() => null) ?? null,
      navigator.storage?.estimate?.().catch(() => null) ?? null,
    ]).then(([probe, estimate]) => {
      if (!active) return;
      setDevice({
        checked: true,
        webgpu: probe?.selectedMode === "webgpu",
        gpu: probe?.gpu || "",
        memoryGb: navigator.deviceMemory || null,
        freeBytes: estimate?.quota ? estimate.quota - (estimate.usage || 0) : null,
      });
    });
    return () => { active = false; };
  }, []);

  return device;
}

// A little gem in a lane's color: the list's bullet.
function Gem({ lane }) {
  return (
    <svg className="start-gem-dot" viewBox="0 0 26 16" aria-hidden="true" style={{ "--gem": FRET_COLORS[lane] }}>
      <ellipse cx="13" cy="9.5" rx="11.5" ry="5.8" className="start-gem-base" />
      <ellipse cx="13" cy="6.5" rx="11.5" ry="5.8" className="start-gem" />
      <ellipse cx="13" cy="5.6" rx="6" ry="2.3" className="start-gem-cap" />
    </svg>
  );
}

function ModelRow({ model, device }) {
  const sizeBytes = FAMILY.downloadMb * 1e6;
  const tight = model.phase !== "ready" && Number.isFinite(device.freeBytes) && device.freeBytes < sizeBytes * 1.2;
  return (
    <li className="start-check">
      <Gem lane={0} />
      <span className="start-check-label">Model</span>
      <span className="start-check-body">
        <span className="start-check-value">
          {FAMILY.label} <span className="mono">{formatBytes(sizeBytes)}</span>
        </span>
        <span className={"start-check-note" + (tight || model.error ? " is-warn" : "")}>
          {model.error
            || (tight ? `Only ${formatBytes(device.freeBytes)} free in this browser.` : "Downloads once, then stays in this browser.")}
        </span>
      </span>
      <span className="start-check-action">
        {model.phase === "ready" ? (
          <span className="start-done"><I.check /> Downloaded</span>
        ) : model.phase === "downloading" ? (
          <span className="start-progress" role="progressbar" aria-valuenow={model.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Model download">
            <span style={{ width: `${Math.max(3, model.percent)}%` }} />
            <b className="mono">{model.percent}%</b>
          </span>
        ) : (
          <button
            type="button"
            className="settings-secondary start-check-btn"
            onClick={model.download}
            disabled={model.phase === "checking" || model.phase === "unavailable"}
          >
            <I.download /> {model.phase === "partial" ? "Finish download" : "Download"}
          </button>
        )}
      </span>
    </li>
  );
}

function DeviceRow({ device }) {
  const lowMemory = Number.isFinite(device.memoryGb) && device.memoryGb < 4;
  const tone = !device.checked ? "" : device.webgpu && !lowMemory ? "good" : "warn";
  return (
    <li className="start-check">
      <Gem lane={3} />
      <span className="start-check-label">Device</span>
      <span className="start-check-body">
        <span className="start-check-value">
          {!device.checked ? "Checking…" : device.webgpu ? "WebGPU" : "CPU only"}
          {device.gpu && <span className="mono start-gpu">{device.gpu}</span>}
        </span>
        <span className={"start-check-note" + (lowMemory ? " is-warn" : "")}>
          {lowMemory
            ? "Low memory: long songs may not finish."
            : device.checked && !device.webgpu
              ? "Works, but a song takes a lot longer."
              : "Needs about 4 GB of free memory."}
        </span>
      </span>
      <span className="start-check-action">
        <span className={"start-pill" + (tone ? ` is-${tone}` : "")}>
          {!device.checked ? "…" : tone === "good" ? "Fast" : "Slow"}
        </span>
      </span>
    </li>
  );
}

function PrivacyRow() {
  return (
    <li className="start-check">
      <Gem lane={4} />
      <span className="start-check-label">Your song</span>
      <span className="start-check-body is-wide">
        <span className="start-check-value">Never leaves this device</span>
        <span className="start-check-note">Nothing is kept here: export to keep your chart.</span>
      </span>
    </li>
  );
}

// ---------- page ----------

export default function Start({ onSong, onOpenChart, confirmCloseSong = () => true }) {
  const [hot, setHot] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const songRef = useRef(null);
  const folderRef = useRef(null);
  const model = useModelState();
  const device = useDeviceState();

  const hasFiles = (event) => Array.from(event.dataTransfer?.items || []).some((item) => item.kind === "file");

  const handleDragOver = (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!hot) setHot(true);
  };

  const handleDragLeave = (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setHot(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setHot(false);
    const file = event.dataTransfer?.files?.[0];
    if (file && confirmCloseSong()) onSong(file);
  };

  const handleFolder = async (event) => {
    const input = event.target;
    if (!input.files?.length) return;
    if (!confirmCloseSong()) {
      input.value = "";
      return;
    }
    setOpenError("");
    setOpening(true);
    try {
      const saved = await saveSongRecord(recordFromImport(await importSongFolder(input.files)));
      onOpenChart(await recordToImported((await getSongRecord(saved.id)) || saved));
    } catch (error) {
      setOpenError(error?.message || "That folder couldn't be opened.");
    } finally {
      setOpening(false);
      input.value = "";
    }
  };

  return (
    <div
      className={"start-page" + (hot ? " is-hot" : "")}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="start-copy">
        <h1 className="start-title">Chart any song</h1>
        <p className="start-sub">Drop in a song and get a five-fret guitar chart for Clone Hero and YARG.</p>

        <div className="start-actions">
          <button type="button" className="btn-primary start-cta" onClick={() => songRef.current?.click()}>
            <I.upload /> Choose a song
          </button>
          <button
            type="button"
            className="settings-secondary start-open-btn"
            onClick={() => folderRef.current?.click()}
            disabled={opening}
          >
            <I.folder /> {opening ? "Opening…" : "Open a Clone Hero song"}
          </button>
          <input
            ref={songRef}
            type="file"
            accept={MEDIA_ACCEPT}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file && confirmCloseSong()) onSong(file);
            }}
          />
          <input ref={folderRef} type="file" webkitdirectory="" directory="" multiple hidden onChange={handleFolder} />
        </div>
        <p className={"start-hint" + (openError ? " is-error" : "")}>
          {openError || <>Or drop it anywhere here. <span className="mono">{FORMATS.join(" · ")}</span></>}
        </p>

        <ul className="start-checks">
          <ModelRow model={model} device={device} />
          <DeviceRow device={device} />
          <PrivacyRow />
        </ul>

        <p className="start-desktop">
          The desktop app is faster, keeps all your songs, and puts them straight into Clone Hero.{" "}
          <a className="start-link" href={DESKTOP_APP_URL} target="_blank" rel="noreferrer">
            Get the desktop app <I.open />
          </a>
        </p>
      </div>

      <div className="start-visual"><StartHighway hot={hot} /></div>

      <div className="start-drop-veil" aria-hidden="true"><span>Let go to start</span></div>
    </div>
  );
}
