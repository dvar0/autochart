function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = amount >= 10 || unit === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

function fileName(filePath) {
  const parts = String(filePath || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "Preparing download";
}

import { I } from "../icons.jsx";
import ProgressRing from "./ProgressRing.jsx";

function progressLabel(progress) {
  if (!progress) return "";
  if (progress.phase === "catalog") return "Fetching package catalog";
  if (progress.phase === "checking") return `Checking ${fileName(progress.filePath)}`;
  if (progress.phase === "verifying") return progress.skipped
    ? `Already downloaded ${fileName(progress.filePath)}`
    : `Verified ${fileName(progress.filePath)}`;
  if (progress.phase === "extracting") return `Extracting ${fileName(progress.filePath)}`;
  if (progress.phase === "complete") return "Chart generation package installed";
  if (progress.phase === "failed") return "Chart generation package failed";
  if (progress.skipped) return `Already downloaded ${fileName(progress.filePath)}`;
  if (progress.filePath) return `Downloading ${fileName(progress.filePath)}`;
  return progress.packLabel ? `Downloading ${progress.packLabel}` : "Downloading chart generation package";
}

export default function InstallProgress({ progress }) {
  if (!progress) return null;
  const percent = clampPercent(progress.percent);
  const filePercent = clampPercent(progress.filePercent);
  const isComplete = progress.phase === "complete";
  const isFailed = progress.phase === "failed";
  const isActive = !isComplete && !isFailed;
  const totalText = [formatBytes(progress.downloadedBytes), formatBytes(progress.totalBytes)]
    .filter(Boolean)
    .join(" / ");
  const fileText = progress.filePath && progress.fileTotalBytes
    ? [formatBytes(progress.fileDownloadedBytes), formatBytes(progress.fileTotalBytes)].filter(Boolean).join(" / ")
    : "";
  const stateClass = isComplete ? " is-complete" : isFailed ? " is-failed" : " is-active";

  return (
    <div className={"install-progress" + stateClass}>
      <div className="install-progress-head">
        <span className="install-progress-mark" aria-hidden="true">
          {isComplete ? (
            <I.check />
          ) : isFailed ? (
            <I.info />
          ) : (
            <ProgressRing value={percent} />
          )}
        </span>
        <b>{progressLabel(progress)}</b>
        <span className="install-progress-pct">{percent == null ? (isActive ? "" : progress.phase) : `${percent}%`}</span>
      </div>
      <div
        className="gen-progressbar"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent ?? undefined}
      >
        <i className={percent == null ? "indeterminate" : ""} style={{ width: `${percent ?? 100}%` }} />
      </div>
      <div className="install-progress-meta">
        <span>{progress.fileIndex && progress.totalFiles ? `File ${progress.fileIndex}/${progress.totalFiles}` : progress.totalFiles ? `${progress.totalFiles} files` : ""}</span>
        <span>{filePercent == null ? fileText : `${filePercent}%${fileText ? ` · ${fileText}` : ""}`}</span>
        <span>{totalText}</span>
      </div>
    </div>
  );
}
