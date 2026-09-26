import { useEffect, useRef, useState } from "react";
import { I } from "../../icons.jsx";
import ProgressRing from "../../components/ProgressRing.jsx";

// Mirrors the ONNX event sequence: queued → audio → demucs → timing →
// smoothing → transcription → chart-writing finalization → done → saved.
// Transcription and chart-writing are deliberately separate stages and ranges.
export const GENERATION_STAGES = [
  { id: "queued", label: "Queue job", detail: "Caching audio and writing the job file" },
  { id: "audio", label: "Read audio", detail: "Preparing the source song" },
  { id: "demucs", label: "Separate stems", detail: "Splitting vocals, guitar, bass and drums" },
  { id: "timing", label: "Detect timing", detail: "Beat detector maps the tempo grid" },
  { id: "smoothing", label: "Smooth tempo", detail: "Steadying the BPM curve between beats" },
  { id: "transcription", label: "Transcribe notes", detail: "The model writes notes, chords and frets" },
  { id: "chart", label: "Write chart", detail: "Converting the decoded sequence into notes.chart" },
  { id: "done", label: "Finalize chart", detail: "Validating the generated chart package" },
  { id: "saved", label: "Load result", detail: "Reading the chart back into the app" },
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
    if (info.status === "running") return `${stage.label}…`;
    const next = GENERATION_STAGES[i + 1];
    return `${(next || stage).label}…`;
  }
  return "Starting engine…";
}

// A run is "streaming" once the model has emitted any partial chart. Demucs
// has completed by then; the partial sequence belongs to transcription and the
// subsequent chart stage writes the final notes.chart package.
export function runIsStreaming(run) {
  return Boolean(run?.live);
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

function stageStateText(info) {
  if (info.status === "running") return "running…";
  if (info.status === "completed") return info.cache ? "cached" : "done";
  if (info.status === "failed") return "failed";
  if (info.status === "skipped") return "skipped";
  return "";
}

function fmtElapsed(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function GenerationProgress({ run }) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const logRef = useRef(null);
  const running = !run.finishedAt;
  const canceled = Boolean(run.canceled);
  const failed = Boolean(run.error) && !canceled;

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

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

  const stageInfos = GENERATION_STAGES.map((_, index) => stageDisplayInfo(run, index));
  const settled = stageInfos.filter(
    (info) => info.status === "completed" || info.status === "skipped",
  ).length;
  const hasLogs = run.logs.length > 0;
  // What the collapsed toggle advertises: progress through the pipeline, plus a
  // hint that there's an engine log waiting behind it.
  const detailMeta = `${settled}/${GENERATION_STAGES.length} steps${hasLogs ? ` · ${run.logs.length} log lines` : ""}`;

  return (
    <div
      className={"gen-progress" + stateClass}
      role="region"
      aria-label="Chart generation progress"
      aria-live="polite"
    >
      <div className="gen-progress-head">
        {running && !failed ? (
          <ProgressRing value={progressPct} className="gen-progress-ring" />
        ) : (
          <span
            className={"gen-progress-mark" + (failed ? " bad" : canceled ? "" : " ok")}
            aria-hidden="true"
          >
            {failed ? "✕" : canceled ? "—" : "✓"}
          </span>
        )}
        <div className="gen-progress-title">
          <b>{headline}</b>
          {run.summary && <small title={run.summary}>{run.summary}</small>}
        </div>
        <span className="gen-progress-clock">
          {running && !failed ? `${progressPct}% · ` : ""}{fmtElapsed(elapsed)}
        </span>
      </div>
      {!failed && (
        <div
          className="gen-progressbar"
          role="progressbar"
          aria-label="Chart generation completion"
          aria-valuenow={barPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${barPct}% complete — ${headline}`}
          aria-busy={running}
        >
          <i style={{ width: `${barPct}%` }} />
        </div>
      )}

      {failed && <div className="gen-progress-error">{run.error}</div>}

      {run.runtimeFallback && (
        <div className="gen-progress-notice" role="status" aria-live="polite">
          {run.runtimeFallback.reason
            ? `Accelerated provider unavailable — used CPU. ${run.runtimeFallback.reason}`
            : "Accelerated provider unavailable — used CPU."}
        </div>
      )}

      <button
        type="button"
        className={"gen-details-toggle" + (expanded ? " open" : "")}
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls="generation-pipeline-details"
      >
        <I.list />
        <span className="gen-details-label">PIPELINE</span>
        {!expanded && <span className="gen-details-meta">{detailMeta}</span>}
        <span className="gen-details-state">
          {expanded ? "Hide" : "Show"}
          <I.chev />
        </span>
      </button>

      {expanded && (
        <div className="gen-details-body" id="generation-pipeline-details">
          <ol className="gen-stage-list">
            {GENERATION_STAGES.map((stage, index) => {
              const info = stageInfos[index];
              const splitting = stage.id === "demucs" && info.status === "running";
              const label = stage.label;
              const detail = stage.detail;
              return (
                <li key={stage.id} className={"gen-stage st-" + info.status}>
                  <span className="gen-stage-dot" aria-hidden="true" />
                  <span className="gen-stage-label">{label}</span>
                  <span className="gen-stage-state">{splitting ? "splitting…" : stageStateText(info)}</span>
                  {info.status === "running" && <span className="gen-stage-detail">{detail}</span>}
                </li>
              );
            })}
          </ol>

          {hasLogs && (
            <div className="gen-log">
              <div className="gen-log-head">ENGINE LOG</div>
              <div className="gen-log-body" ref={logRef}>
                {run.logs.map((line, i) => (
                  <div key={i} className={"gen-log-line" + (line.stream === "stderr" ? " err" : "")}>
                    {line.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
