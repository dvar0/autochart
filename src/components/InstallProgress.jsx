import { formatSize as formatBytes } from "../data/generationCatalog.js";
import { t, tn } from "../i18n/index.js";

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function fileName(filePath) {
  const parts = String(filePath || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || t("Preparing download");
}

import { I } from "../icons.jsx";
import ProgressRing from "./ProgressRing.jsx";

function progressLabel(progress) {
  if (!progress) return "";
  const file = fileName(progress.filePath);
  if (progress.phase === "catalog") return t("Fetching package catalog");
  if (progress.phase === "checking") return t("Checking {file}", { file });
  if (progress.phase === "verifying") return progress.skipped
    ? t("Already downloaded {file}", { file })
    : t("Verified {file}", { file });
  if (progress.phase === "extracting") return t("Extracting {file}", { file });
  if (progress.phase === "complete") return t("Chart generation package installed");
  if (progress.phase === "failed") return t("Chart generation package failed");
  if (progress.skipped) return t("Already downloaded {file}", { file });
  if (progress.filePath) return t("Downloading {file}", { file });
  return progress.packLabel ? t("Downloading {file}", { file: progress.packLabel }) : t("Downloading chart generation package");
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
        <span className="install-progress-pct">{percent == null ? (isActive ? "" : isComplete ? t("Done") : t("Failed")) : `${percent}%`}</span>
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
        <span>{progress.fileIndex && progress.totalFiles
          ? t("File {number}/{total}", { number: progress.fileIndex, total: progress.totalFiles })
          : progress.totalFiles ? tn(progress.totalFiles, "{count} file", "{count} files") : ""}</span>
        <span>{filePercent == null ? fileText : `${filePercent}%${fileText ? ` · ${fileText}` : ""}`}</span>
        <span>{totalText}</span>
      </div>
    </div>
  );
}
