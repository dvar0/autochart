// A take's beat grid, for checking that the takes in one final chart share it.
// Shared by the renderer and the Electron main process (the Library's project
// list carries only the key, not the chart). Dependency-free, like finalSlots.js.

function sectionBody(lines, name) {
  const header = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (header < 0) return null;
  let open = header + 1;
  while (open < lines.length && lines[open].trim() !== "{") open++;
  let close = open + 1;
  while (close < lines.length && lines[close].trim() !== "}") close++;
  if (open >= lines.length || close >= lines.length) return null;
  return lines.slice(open + 1, close);
}

function songTimingValues(lines) {
  const values = { resolution: 192, offset: 0 };
  for (const line of sectionBody(lines, "Song") || []) {
    const match = line.trim().match(/^(Resolution|Offset)\s*=\s*(.+)$/i);
    if (!match) continue;
    const value = Number(match[2]);
    const key = match[1].toLowerCase();
    if (Number.isFinite(value) && (key !== "resolution" || value > 0)) values[key] = value;
  }
  return values;
}

export function chartTimingSignature(chartText = "") {
  const lines = String(chartText || "").split(/\r?\n/);
  const body = (sectionBody(lines, "SyncTrack") || []).map((line) => line.trim()).filter(Boolean).join("\n");
  if (!body) return "";
  // Resolution and offset both affect playback, even when sync lines match.
  const song = songTimingValues(lines);
  return `res:${song.resolution};offset:${song.offset}\n${body}`;
}

// The signature as a short key (two FNV-1a hashes): only compared for equality.
export function chartTimingKey(chartText = "") {
  const signature = chartTimingSignature(chartText);
  if (!signature) return "";
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < signature.length; i++) {
    const code = signature.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x811c9dc5) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}:${signature.length}`;
}
