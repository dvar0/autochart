import { useEffect, useRef, useState } from "react";
import { I } from "../icons.jsx";
import { DeviceReadout, UNCHECKED_DEVICE, deviceFact, deviceFromProbe } from "../components/DeviceFacts.jsx";
import { FRET_COLORS } from "../data/notePalette.js";
import { MEDIA_ACCEPT } from "../services/mediaMetadata.js";
import { importSongFolder, saveImportedSong } from "../services/songImport.js";
import { getSongRecord, recordToImported } from "../services/songLibrary.js";
import { electronHardware } from "../services/runtimeBridge.js";

// The browser version's home: where a project starts. There is no library on
// the web, so this page is the way in: a new song, or a Clone Hero song folder
// to keep working on. Above the buttons, a song strip scrolls past a playhead
// that feeds a small highway: audio in, chart out. A pill says what this
// device can do; the model itself downloads with the first song.

const DESKTOP_APP_URL = "https://github.com/dvar0/autochart/releases";

const still = () => Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

// ---------- the highway ----------

// A looping little riff: lane (0-4) and beat. Chords share a beat.
const RIFF = [
  [0, 0], [1, 1], [2, 2], [1, 3], [0, 4], [2, 4.5], [3, 5], [4, 6], [3, 6.5], [2, 7],
  [0, 8], [2, 8], [1, 9], [3, 9], [2, 10], [4, 10], [3, 11], [1, 11.5], [0, 12], [2, 13], [4, 14], [1, 14.5], [3, 15],
];
const RIFF_BEATS = 16;
const BEAT_SECONDS = 0.34;
const TRAVEL_BEATS = 5; // how long a gem takes from the horizon to the strikeline

const ROAD = { width: 320, top: 0, strike: 200, bottom: 236, topHalf: 40, bottomHalf: 150 };

function halfWidthAt(y) {
  return ROAD.topHalf + ((ROAD.bottomHalf - ROAD.topHalf) * (y - ROAD.top)) / (ROAD.bottom - ROAD.top);
}

function laneX(lane, y) {
  const half = halfWidthAt(y);
  return ROAD.width / 2 - half + ((lane + 0.5) * 2 * half) / 5;
}

// 0 at the horizon, 1 at the strikeline; eased so gems speed up as they near.
function yAt(progress) {
  return ROAD.top + (ROAD.strike - ROAD.top) * (progress * 0.55 + progress * progress * 0.45);
}

// Loud where the riff has a note, a low rumble in between.
function waveAmplitude(beat) {
  const at = ((beat % RIFF_BEATS) + RIFF_BEATS) % RIFF_BEATS;
  const near = Math.min(...RIFF.map(([, noteAt]) => {
    const d = Math.abs(at - noteAt);
    return Math.min(d, RIFF_BEATS - d);
  }));
  const peak = near < 0.07 ? 0.95 : near < 0.2 ? 0.55 : 0;
  return Math.max(peak, 0.16 + 0.2 * Math.abs(Math.sin(beat * 1.7) * Math.cos(beat * 0.45)));
}

function StartHighway({ hot, startAt }) {
  const gemRefs = useRef([]);
  const ringRefs = useRef([]);
  const copies = 2;

  useEffect(() => {
    let frame = 0;
    const place = (now) => {
      const beat = (Math.max(0, now - startAt) / 1000) / BEAT_SECONDS;
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
          const scale = 0.42 + 0.58 * Math.min(1.1, (y - ROAD.top) / (ROAD.strike - ROAD.top));
          node.setAttribute("transform", `translate(${laneX(lane, y).toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(3)})`);
          node.setAttribute("opacity", progress > 1 ? String(Math.max(0, 1 - (progress - 1) / 0.18)) : progress < 0.08 ? String(progress / 0.08) : "1");
          if (progress > 0.97 && progress < 1.08) lit[lane] = 1;
        }
      });
      ringRefs.current.forEach((ring, lane) => ring?.classList.toggle("is-lit", Boolean(lit[lane])));
      frame = requestAnimationFrame(place);
    };
    if (still()) {
      place(startAt + BEAT_SECONDS * 1000 * 3.4);
      cancelAnimationFrame(frame);
      return undefined;
    }
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [startAt]);

  const lanes = [0, 1, 2, 3, 4];
  const cx = ROAD.width / 2;
  const outline = `M${cx - ROAD.topHalf} ${ROAD.top} L${cx + ROAD.topHalf} ${ROAD.top} L${cx + ROAD.bottomHalf} ${ROAD.bottom} L${cx - ROAD.bottomHalf} ${ROAD.bottom} Z`;
  return (
    <svg className={"start-highway" + (hot ? " is-hot" : "")} viewBox={`0 0 ${ROAD.width} ${ROAD.bottom}`} preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <defs>
        <linearGradient id="start-road" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--start-road-far)" />
          <stop offset="1" stopColor="var(--start-road-near)" />
        </linearGradient>
        <clipPath id="start-road-clip"><path d={outline} /></clipPath>
      </defs>
      <path d={outline} fill="url(#start-road)" />
      <g clipPath="url(#start-road-clip)">
        {[1, 2, 3, 4].map((i) => (
          <line
            key={i}
            x1={cx - ROAD.topHalf + (i * 2 * ROAD.topHalf) / 5}
            y1={ROAD.top}
            x2={cx - ROAD.bottomHalf + (i * 2 * ROAD.bottomHalf) / 5}
            y2={ROAD.bottom}
            className="start-lane-line"
          />
        ))}
        {[0.18, 0.4, 0.62, 0.84].map((p) => {
          const y = yAt(p);
          return <line key={p} x1={cx - halfWidthAt(y)} x2={cx + halfWidthAt(y)} y1={y} y2={y} className="start-beat-line" />;
        })}
      </g>
      <path d={`M${cx - ROAD.topHalf} ${ROAD.top} L${cx - ROAD.bottomHalf} ${ROAD.bottom}`} className="start-road-edge" />
      <path d={`M${cx + ROAD.topHalf} ${ROAD.top} L${cx + ROAD.bottomHalf} ${ROAD.bottom}`} className="start-road-edge" />
      {lanes.map((lane) => (
        <g
          key={lane}
          ref={(node) => { ringRefs.current[lane] = node; }}
          className="start-ring"
          transform={`translate(${laneX(lane, ROAD.strike)} ${ROAD.strike})`}
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

// ---------- the song strip feeding the highway ----------

// The song scrolls past a playhead fixed in the middle; whatever crosses it
// drops into the highway below as gems. The strip runs TRAVEL_BEATS ahead of
// the highway, so a loud hit reaches the strikeline as its gem does.
const FEED_W = 960;
const FEED_PX_PER_BEAT = 46;
const FEED_STEP = 0.25; // beats between waveform bars
const FEED_BARS = Math.ceil(FEED_W / FEED_PX_PER_BEAT / FEED_STEP) + 2;
const FEED_SECTION_BEATS = 16;
const FEED_SECTIONS = [["Verse", 0, 0.7], ["Chorus", 1, 1], ["Verse", 0, 0.7], ["Solo", 3, 1]];
const FEED_MID = 70;
const FEED_AMP = 36;
const FEED_LANE_Y = [38, 54, 70, 86, 102]; // green on top, like the editor's roll
const FEED_NOTE_POOL = 40;

function feedSection(beat) {
  const index = Math.floor(beat / FEED_SECTION_BEATS);
  return { index, section: FEED_SECTIONS[((index % FEED_SECTIONS.length) + FEED_SECTIONS.length) % FEED_SECTIONS.length] };
}

// The riff's notes from `from` to `to` (song beats), every loop of it.
function feedNotes(from, to) {
  const notes = [];
  for (let loop = Math.floor(from / RIFF_BEATS); loop * RIFF_BEATS <= to; loop += 1) {
    RIFF.forEach(([lane, at]) => {
      const beat = loop * RIFF_BEATS + at;
      if (beat >= from && beat <= to) notes.push([lane, beat]);
    });
  }
  return notes;
}

function SongFeed({ hot, startAt }) {
  const barRefs = useRef([]);
  const sectionRefs = useRef([]);
  const noteRefs = useRef([]);

  useEffect(() => {
    let frame = 0;
    const center = FEED_W / 2;
    const place = (now) => {
      const songBeat = (Math.max(0, now - startAt) / 1000) / BEAT_SECONDS + TRAVEL_BEATS;
      const xAt = (beat) => center + (beat - songBeat) * FEED_PX_PER_BEAT;
      const first = Math.ceil((songBeat - center / FEED_PX_PER_BEAT) / FEED_STEP) * FEED_STEP;
      barRefs.current.forEach((node, index) => {
        if (!node) return;
        const beat = first + index * FEED_STEP;
        const x = xAt(beat);
        const h = FEED_AMP * waveAmplitude(beat) * feedSection(beat).section[2];
        node.setAttribute("x", (x - 2).toFixed(2));
        node.setAttribute("y", (FEED_MID - h).toFixed(2));
        node.setAttribute("height", (h * 2).toFixed(2));
        node.classList.toggle("is-past", x < center);
      });
      // Behind the playhead the song is charted: its notes sit in the lanes,
      // each one popping in as it crosses.
      const charted = feedNotes(songBeat - center / FEED_PX_PER_BEAT - 1, songBeat);
      noteRefs.current.forEach((node, index) => {
        if (!node) return;
        const note = charted[index];
        if (!note) {
          node.setAttribute("opacity", "0");
          return;
        }
        const [lane, beat] = note;
        const age = songBeat - beat;
        const pop = Math.min(1, 0.4 + age * 3);
        node.setAttribute("opacity", "1");
        node.setAttribute("transform", `translate(${xAt(beat).toFixed(2)} ${FEED_LANE_Y[lane]}) scale(${pop.toFixed(3)})`);
        node.style.setProperty("--gem", FRET_COLORS[lane]);
      });
      const firstSection = Math.floor((songBeat - center / FEED_PX_PER_BEAT) / FEED_SECTION_BEATS);
      sectionRefs.current.forEach((node, index) => {
        if (!node) return;
        const at = (firstSection + index) * FEED_SECTION_BEATS;
        const { section } = feedSection(at);
        const x0 = xAt(at);
        const x1 = xAt(at + FEED_SECTION_BEATS) - 3;
        const [rect, label] = node.children;
        rect.setAttribute("x", x0.toFixed(2));
        rect.setAttribute("width", Math.max(0, x1 - x0).toFixed(2));
        label.setAttribute("x", (Math.max(x0, 0) + 8).toFixed(2));
        label.textContent = section[0];
        node.style.setProperty("--sec", FRET_COLORS[section[1]]);
        node.classList.toggle("is-charted", x0 < center);
      });
      frame = requestAnimationFrame(place);
    };
    if (still()) {
      place(startAt + BEAT_SECONDS * 1000 * 3.4);
      return undefined;
    }
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [startAt]);

  return (
    <svg className={"start-feed" + (hot ? " is-hot" : "")} viewBox={`0 0 ${FEED_W} 128`} aria-hidden="true">
      <defs>
        <linearGradient id="start-feed-fade" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".08" stopColor="#fff" />
          <stop offset=".92" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="start-feed-mask"><rect width={FEED_W} height="128" fill="url(#start-feed-fade)" /></mask>
      </defs>
      <g mask="url(#start-feed-mask)">
        {Array.from({ length: 3 }, (_, index) => (
          <g key={index} ref={(node) => { sectionRefs.current[index] = node; }} className="start-feed-sec">
            <rect y="0" height="22" rx="5" />
            <text y="15" />
          </g>
        ))}
        <rect x="0" y="28" width={FEED_W} height="84" rx="8" className="start-feed-track" />
        {FEED_LANE_Y.map((y) => <line key={y} x1="10" x2={FEED_W - 10} y1={y} y2={y} className="start-feed-lane" />)}
        <g className="start-feed-wave">
          {Array.from({ length: FEED_BARS }, (_, index) => (
            <rect key={index} ref={(node) => { barRefs.current[index] = node; }} width="4" rx="2" />
          ))}
        </g>
        {Array.from({ length: FEED_NOTE_POOL }, (_, index) => (
          <g key={index} ref={(node) => { noteRefs.current[index] = node; }} opacity="0" className="start-feed-note">
            <circle cy="1.6" r="7" className="start-gem-base" />
            <circle r="7" className="start-gem" />
            <circle cx="-1.8" cy="-2.2" r="2.3" className="start-gem-cap" />
          </g>
        ))}
      </g>
      <g className="start-feed-head">
        <line x1={FEED_W / 2} x2={FEED_W / 2} y1="0" y2="128" />
        <rect x={FEED_W / 2 - 6} y="22.5" width="12" height="9" rx="4.5" />
      </g>
    </svg>
  );
}

function DesktopNote() {
  return (
    <p className="start-desktop-note">
      <I.monitor /> Faster on desktop, and saves straight to Clone Hero.
      <a className="start-link" href={DESKTOP_APP_URL} target="_blank" rel="noreferrer">
        Get the app <I.open />
      </a>
    </p>
  );
}

// The device as a status pill, so it isn't mistaken for a tagline; it opens to
// show what was checked.
function DeviceFact({ device, onOpenSettings }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // The pill sits low on the page; bring the whole popover into view.
  useEffect(() => {
    if (open) popRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);

  const fact = deviceFact(device);

  return (
    <div className="start-fact-wrap" ref={wrapRef}>
      <button
        className={"start-fact" + (fact.tone ? ` is-${fact.tone}` : "") + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        disabled={!device.checked}
        aria-expanded={open}
      >
        <span className="start-fact-dot" />
        <span className="start-fact-label">This device</span>
        <span className="start-fact-value">{fact.label}</span>
        <I.chev className="chev" />
      </button>
      {open && (
        <div className="start-fact-pop" ref={popRef}>
          <DeviceReadout device={device} />
          <button className="start-link start-fact-settings" onClick={onOpenSettings}>
            <I.gear /> Change in Settings
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- this device ----------

function useDeviceState() {
  const [device, setDevice] = useState(UNCHECKED_DEVICE);

  useEffect(() => {
    let active = true;
    Promise.resolve(electronHardware()?.probe().catch(() => null) ?? null).then((probe) => {
      if (active) setDevice(deviceFromProbe(probe));
    });
    return () => { active = false; };
  }, []);

  return device;
}

// ---------- page ----------

export default function Start({ onSong, onOpenChart, onOpenSettings, confirmCloseSong = () => true }) {
  const [hot, setHot] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const [clockStart] = useState(() => performance.now());
  const songRef = useRef(null);
  const folderRef = useRef(null);
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
      const saved = await saveImportedSong(await importSongFolder(input.files));
      onOpenChart(await recordToImported((await getSongRecord(saved.id)) || saved));
    } catch (error) {
      setOpenError(error?.message || "That folder couldn't be opened.");
    } finally {
      setOpening(false);
      input.value = "";
    }
  };

  const actions = (
    <>
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
        {openError || <><I.shield /> Or drop a song anywhere. It never leaves this device.</>}
      </p>
    </>
  );

  return (
    <div
      className={"start-page" + (hot ? " is-hot" : "")}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="start-head">
        <h1 className="start-title">Chart any song</h1>
        <p className="start-sub">Get a five-fret guitar chart for Clone Hero and YARG, right in your browser.</p>
        <div className="start-feed-wrap">
          <SongFeed hot={hot} startAt={clockStart} />
          <StartHighway hot={hot} startAt={clockStart} />
        </div>
        {actions}
        <div className="start-shared">
          <DeviceFact device={device} onOpenSettings={onOpenSettings} />
          <DesktopNote />
        </div>
      </div>
      <div className="start-drop-veil" aria-hidden="true"><span>Let go to start</span></div>
    </div>
  );
}
