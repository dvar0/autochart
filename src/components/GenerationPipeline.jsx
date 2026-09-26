import { COMPONENT_LABELS } from "../data/humanLabels.js";
import { STANDARD_PACK_DOWNLOAD_BYTES } from "../data/generationCatalog.js";

const DEFAULT_CONTENTS = [
  {
    id: "demucs",
    label: COMPONENT_LABELS.demucs,
    description: "Separates instruments from the song.",
    delivery: "download",
    fileCount: 3,
  },
  {
    id: "beat-this",
    label: COMPONENT_LABELS["beat-this"],
    description: "Finds the song's beats and timing.",
    delivery: "download",
    fileCount: 2,
  },
  {
    id: "fretformer",
    label: COMPONENT_LABELS.fretformer,
    description: "Creates the playable note chart.",
    delivery: "download",
    fileCount: 6,
  },
  {
    id: "ffmpeg",
    label: COMPONENT_LABELS.ffmpeg,
    description: "Reads and prepares audio and video files.",
    delivery: "bundled",
  },
  {
    id: "local-runtime",
    label: COMPONENT_LABELS["local-runtime"],
    description: "Runs the models locally using ONNX Runtime and Node.js.",
    delivery: "bundled",
  },
  {
    id: "licenses",
    label: COMPONENT_LABELS.licenses,
    description: "Installs the required model, Demucs, and Beat This license notices with the files.",
    delivery: "bundled-copy",
    fileCount: 4,
  },
];

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

export function generationDownloadSize(pack) {
  return formatBytes(pack?.downloadBytes ?? STANDARD_PACK_DOWNLOAD_BYTES);
}

export default function GenerationPipeline({ pack }) {
  const contents = Array.isArray(pack?.installContents) && pack.installContents.length
    ? pack.installContents
    : DEFAULT_CONTENTS;

  return (
    <div className="setup-pipeline-list">
      {contents.filter((item) => item.id !== "licenses").map((item) => (
        <div className="setup-pipeline-item" key={item.id}>
          <div>
            <b>{item.label}</b>
            <span>{item.description}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
