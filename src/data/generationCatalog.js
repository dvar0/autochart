import catalog from "../../engine/catalog.json" with { type: "json" };

const standardPack = Array.isArray(catalog.packs)
  ? catalog.packs.find((pack) => pack.id === catalog.defaults?.packId)
  : null;

export const STANDARD_PACK_DOWNLOAD_BYTES = Number(standardPack?.downloadBytes) || 0;

// Decimal units, like the download pages and the install docs.
export function formatSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  const digits = amount >= 10 || unit === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

export function generationDownloadSize(pack) {
  return formatSize(pack?.downloadBytes ?? STANDARD_PACK_DOWNLOAD_BYTES);
}
