import { useEffect, useRef, useState } from "react";
import { I } from "../../icons.jsx";
import ProgressRing from "../../components/ProgressRing.jsx";
import { LITE_FAMILY, minutesText, separationSecondsLeft } from "./liteOffer.js";

// Mirrors the ONNX event sequence: queued → audio → demucs → timing →
// smoothing → transcription → chart-writing finalization → done → saved.
// Transcription and chart-writing are deliberately separate stages and ranges.
export const GENERATION_STAGES = [
  { id: "queued", label: "Queue job" },
  { id: "audio", label: "Read audio" },
  { id: "demucs", label: "Separate stems" },
  { id: "timing", label: "Detect timing" },
  { id: "smoothing", label: "Smooth tempo" },
  { id: "transcription", label: "Transcribe notes" },
  { id: "chart", label: "Write chart" },
  { id: "done", label: "Finalize chart" },
  { id: "saved", label: "Load result" },
];

const PROGRESS_ORDER = GENERATION_STAGES.map((stage) => stage.id);
const STAGE_RANGES = {
  queued: [0, 2],
  audio: [2, 5],
  demucs: [5, 30],
  timing: [30, 42],
  smoothing: [42, 48],
  transcription: [48, 86],
  chart: [86, 95],
  done: [95, 98],
  saved: [98, 100],
};

// The panel's steps: the stages someone watching would tell apart. Each one's
// share of the track is its share of the run percent.
const GENERATION_STEPS = [
  { id: "read", label: "Read audio", stages: ["queued", "audio"] },
  { id: "stems", label: "Separate stems", stages: ["demucs"] },
  { id: "beats", label: "Detect timing", stages: ["timing", "smoothing"] },
  { id: "notes", label: "Transcribe notes", stages: ["transcription"] },
  { id: "chart", label: "Write chart", stages: ["chart", "done", "saved"] },
].map((step) => ({
  ...step,
  start: STAGE_RANGES[step.stages[0]][0],
  end: STAGE_RANGES[step.stages[step.stages.length - 1]][1],
}));

function stageInfoFor(run, id) {
  return run?.stages?.[id];
}

function stageInnerFraction(run, id) {
  const scraped = run?.stageProgress?.[id];
  let inner = Number.isFinite(scraped) ? Math.max(0, Math.min(100, scraped)) / 100 : 0;
  if (id === "transcription") {
    const live = run?.live;
    const committedBeats = Number(live?.committedBeats) || 0;
    const totalBeats = Number(live?.totalBeats) || 0;
    if (totalBeats > 0) inner = Math.max(inner, Math.min(1, committedBeats / totalBeats));
  }
  return inner;
}

// The single canonical run percent. It is the ONLY function any component should
// call to derive a number for the progress bar — no component-local percent
// math. It composes all sources (stage status, per-stage scraped progress, the
// streamed committedBeats fraction) into the weighted stage model and clamps to
// the running maximum so the bar within one run never moves backwards.
const PROGRESS_MAX_BY_RUN = new Map();

export function runProgressPercent(run) {
  if (!run) return 0;
  if (run.finishedAt && run.ok && !run.error && !run.canceled) {
    PROGRESS_MAX_BY_RUN.delete(run.startedAt);
    return 100;
  }
  let pct = 0;
  let reached = false;
  for (const id of PROGRESS_ORDER) {
    const info = stageInfoFor(run, id);
    if (!info) continue;
    const [start, end] = STAGE_RANGES[id] || [0, 0];
    const status = info.status;
    if (status === "completed") {
      pct = Math.max(pct, end);
      reached = true;
    } else if (status === "running") {
      const inner = stageInnerFraction(run, id);
      pct = Math.max(pct, start + (end - start) * inner);
      reached = true;
    } else if (status === "skipped") {
      pct = Math.max(pct, end);
    } else if (status === "failed") {
      pct = Math.max(pct, start);
      reached = true;
    }
  }
  if (!reached && run.startedAt) pct = Math.max(pct, 1);

  // Monotonic guard per run: never let the displayed percent drop within the
  // same run (keyed by startedAt, which is unique per run). A new run gets a
  // fresh ceiling.
  const key = run.startedAt || 0;
  let max = PROGRESS_MAX_BY_RUN.get(key);
  if (max == null) {
    if (PROGRESS_MAX_BY_RUN.size > 16) PROGRESS_MAX_BY_RUN.clear();
    max = 0;
  }
  if (pct > max) {
    PROGRESS_MAX_BY_RUN.set(key, pct);
    max = pct;
  }
  if (run.finishedAt && run.canceled) {
    PROGRESS_MAX_BY_RUN.delete(run.startedAt);
  }
  return Math.min(99, Math.round(Math.max(max, pct)));
}

export function describeRunStage(run) {
  if (!run) return "";
  if (run.canceled) return "Stopped";
  if (run.error) return "Generation failed";
  if (run.finishedAt) return "Chart ready";
  for (let i = GENERATION_STAGES.length - 1; i >= 0; i -= 1) {
    const stage = GENERATION_STAGES[i];
    const info = stageInfoFor(run, stage.id);
    if (!info) continue;
    // The board shows how much; this stays one line.
    if (info.status === "running" && info.downloading) return "Downloading the model…";
    if (info.status === "running") return `${stage.label}…`;
    const next = GENERATION_STAGES[i + 1];
    return `${(next || stage).label}…`;
  }
  return run.waitingForQueue ? "Waiting for the queue…" : "Starting engine…";
}

// A run is "streaming" once the model has emitted any partial chart. Demucs
// has completed by then; the partial sequence belongs to transcription and the
// subsequent chart stage writes the final notes.chart package.
export function runIsStreaming(run) {
  return Boolean(run?.live);
}

// { loaded, total } in bytes while the run is downloading the model, else null.
export function runDownload(run) {
  if (!run || run.finishedAt || !run.download) return null;
  const downloading = Object.values(run.stages || {}).some((info) => info?.status === "running" && info.downloading);
  return downloading ? run.download : null;
}

export function megabytesOf(bytes) {
  return Math.round((Number(bytes) || 0) / 1e6);
}

export function runIsSeparating(run) {
  if (!run || run.finishedAt || runIsStreaming(run)) return false;
  // Cached stems leave Demucs completed; transcription warm-up is not stem separation.
  if (run.willSeparate === false) return false;
  return run.stages?.demucs?.status === "running";
}
function stageDisplayInfo(run, index) {
  const reported = stageInfoFor(run, GENERATION_STAGES[index].id);
  if (reported) return reported;
  if (run.finishedAt && run.ok && !run.error && !run.canceled) return { status: "completed" };
  const laterStarted = GENERATION_STAGES.slice(index + 1).some((stage) => stageInfoFor(run, stage.id));
  if (laterStarted) return { status: "skipped" };
  return { status: "pending" };
}

function stepStatus(run, statuses) {
  let status = "running";
  if (statuses.includes("failed")) status = "failed";
  else if (statuses.every((s) => s === "pending")) status = "pending";
  else if (statuses.every((s) => s === "skipped")) status = "skipped";
  else if (statuses.every((s) => s === "completed" || s === "skipped")) status = "completed";
  // A run that ended early leaves its step "running"; that step is where it ended.
  if (run.finishedAt && (status === "running" || status === "failed")) {
    if (run.canceled) return "stopped";
    if (run.error) return "failed";
  }
  return status;
}

function stepView(run, step, percent, now) {
  const infos = step.stages.map((id) => stageDisplayInfo(run, PROGRESS_ORDER.indexOf(id)));
  const status = stepStatus(run, infos.map((info) => info.status));
  const timed = infos.filter((info) => info.since);
  let seconds = 0;
  if (timed.length && (status === "completed" || status === "running")) {
    const since = Math.min(...timed.map((info) => info.since));
    const until = status === "running" ? now : Math.max(...timed.map((info) => info.until || info.since));
    seconds = Math.max(0, (until - since) / 1000);
  }
  const reused = status === "completed" && timed.length > 0 && timed.every((info) => info.cache);
  let note = seconds >= 1 ? fmtElapsed(seconds) : "";
  if (reused) note = "reused";
  else if (status === "failed" || status === "stopped" || status === "skipped") note = status;
  return {
    ...step,
    status,
    note,
    label: status === "running" && infos.some((info) => info.downloading) ? "Download model" : step.label,
    fill: Math.max(0, Math.min(1, (percent - step.start) / (step.end - step.start))),
  };
}

// Engine libraries color their output; healthy runs write warnings to stderr
// too, so the log stays one color and failures speak through the error box.
const ANSI_COLOR = /\u001b\[[0-9;]*m/g;
const plainLogLine = (message) => String(message || "").replace(ANSI_COLOR, "");

export function runSteps(run, percent = runProgressPercent(run), now = Date.now()) {
  return GENERATION_STEPS.map((step) => stepView(run, step, percent, now));
}

function StepMark({ step }) {
  if (step.status === "running") return <ProgressRing value={step.fill * 100} />;
  if (step.status === "completed") return <I.check />;
  if (step.status === "failed") return <I.close />;
  return <i />;
}

// Offers Fretformer 2 Lite while a slow separation runs, then follows the
// switch (stop, download, rerun).
function LiteOffer({ run, now, offer, liteSwitch, onSwitch, onKeepGoing }) {
  if (liteSwitch) {
    const text = liteSwitch.phase === "downloading"
      ? `Downloading ${LITE_FAMILY.label}… ${Math.round(liteSwitch.percent || 0)}%`
      : liteSwitch.phase === "failed"
        ? liteSwitch.error
        : liteSwitch.phase === "starting"
          ? `Starting with ${LITE_FAMILY.label}…`
          : "Stopping…";
    return (
      <div className={"gen-lite-offer" + (liteSwitch.phase === "failed" ? " is-failed" : "")} role="status" aria-live="polite">
        <p>{text}</p>
        {liteSwitch.phase === "failed" && (
          <div className="gen-lite-actions">
            <button type="button" className="settings-secondary" onClick={onSwitch}>Try again</button>
          </div>
        )}
      </div>
    );
  }
  if (!offer) return null;
  const left = separationSecondsLeft(run.separationClock, now);
  return (
    <div className="gen-lite-offer" role="status" aria-live="polite">
      <p>
        Separating stems needs {left == null ? "a long time" : minutesText(left)} more on this device.{" "}
        <b>{LITE_FAMILY.label}</b> skips this step and finishes much sooner, but follows the melody less closely.
        {offer.needsDownload && LITE_FAMILY.downloadMb ? ` Switching downloads it first (${LITE_FAMILY.downloadMb} MB).` : ""}
      </p>
      <div className="gen-lite-actions">
        <button type="button" className="settings-secondary" onClick={onSwitch}>Switch to Lite</button>
        <button type="button" className="settings-secondary" onClick={onKeepGoing}>Keep going</button>
      </div>
    </div>
  );
}

function fmtElapsed(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function GenerationProgress({ run, liteOffer = null, liteSwitch = null, onSwitchToLite, onKeepSeparating }) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const detailsRef = useRef(null);
  const logRef = useRef(null);
  const running = !run.finishedAt;
  const canceled = Boolean(run.canceled);
  const failed = Boolean(run.error) && !canceled;

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  // Something went wrong: that's what the details are for.
  useEffect(() => setExpanded(failed), [failed]);

  // The panel sits at the foot of the rail; opening it shouldn't land off-screen.
  useEffect(() => {
    if (expanded) detailsRef.current?.scrollIntoView({ block: "nearest" });
  }, [expanded]);

  // Keep the log pinned to the latest line — including right after it opens.
  useEffect(() => {
    if (!expanded) return;
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [run.logs.length, expanded]);

  const elapsed = Math.max(0, ((run.finishedAt || now) - run.startedAt) / 1000);
  const separating = runIsSeparating(run);
  const stageHeadline = describeRunStage(run);
  const headline = canceled
    ? "Stopped"
    : failed
      ? "Generation failed"
      : !running
        ? "Chart ready"
        : separating
          ? "Separating stems"
          : stageHeadline || "Starting engine…";
  const progressPct = runProgressPercent(run);
  const barPct = !running && !failed && !canceled ? 100 : progressPct;
  const stateClass = failed ? " is-failed" : canceled ? " is-stopped" : running ? " is-running" : " is-done";
  const steps = runSteps(run, barPct, now);

  return (
    <div className={"gen-progress" + stateClass} role="region" aria-label="Chart generation progress">
      <button
        type="button"
        className={"gen-progress-head" + (expanded ? " open" : "")}
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls="generation-pipeline-details"
      >
        <span className="gen-progress-mark" aria-hidden="true">
          {running ? <ProgressRing value={progressPct} /> : failed ? <I.close /> : canceled ? <i /> : <I.check />}
        </span>
        <span className="gen-progress-title" aria-live="polite">{headline}</span>
        <span className="gen-progress-clock">{fmtElapsed(elapsed)}</span>
        <I.chev />
      </button>
      <div
        className="gen-track"
        role="progressbar"
        aria-label="Chart generation completion"
        aria-valuenow={barPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${barPct}% complete — ${headline}`}
        aria-busy={running}
      >
        {steps.map((step) => (
          <span key={step.id} className={"st-" + step.status} style={{ flexGrow: step.end - step.start }}>
            <i style={{ width: `${step.fill * 100}%` }} />
          </span>
        ))}
      </div>

      {failed && <div className="gen-progress-error">{run.error}</div>}

      <LiteOffer
        run={run}
        now={now}
        offer={liteOffer}
        liteSwitch={liteSwitch}
        onSwitch={onSwitchToLite}
        onKeepGoing={onKeepSeparating}
      />

      {run.runtimeFallback && (
        <div className="gen-progress-notice" role="status" aria-live="polite">
          {run.runtimeFallback.reason
            ? `Ran on CPU, the GPU wasn't available. ${run.runtimeFallback.reason}`
            : "Ran on CPU, the GPU wasn't available."}
        </div>
      )}

      {expanded && (
        <div className="gen-details" id="generation-pipeline-details" ref={detailsRef}>
          <ol className="gen-steps">
            {steps.map((step) => (
              <li key={step.id} className={"gen-step st-" + step.status}>
                <span className="gen-step-mark" aria-hidden="true"><StepMark step={step} /></span>
                <span>{step.label}</span>
                <small>{step.note}</small>
              </li>
            ))}
          </ol>

          {run.summary && <p className="gen-run-summary">{run.summary}</p>}

          {run.logs.length > 0 && (
            <div className="gen-log-body" ref={logRef} tabIndex={0} aria-label="Engine log">
              {run.logs.map((line, i) => (
                <div key={i} className="gen-log-line">{plainLogLine(line.message)}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
