// Moves a .chart later in time, so a take charted on audio with less lead-in
// silence plays on audio with more. Every event moves by a whole number of
// beats; the ticks freed at the start become one-beat bars at a tempo that
// lasts exactly the delay, and the chart's own first time signature and tempo
// start where its tick 0 lands, so its bars and beats stay as they were.
// Shared by the desktop export, the browser export and the folder import.
// Kept dependency-free.

// About 120 BPM in the lead-in, whatever its length.
const LEAD_BEAT_MS = 500;

// { chartText, ticks }: the delayed text and how far its events moved.
export function delayChart(chartText, ms) {
  const text = String(chartText ?? "");
  const delayMs = Math.round(Number(ms));
  if (!Number.isFinite(delayMs) || delayMs <= 0 || !text.trim()) return { chartText: text, ticks: 0 };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  let section = "";
  let resolution = 192;
  for (const line of lines) {
    const header = line.trim().match(/^\[(.+)\]$/);
    if (header) section = header[1];
    const match = section === "Song" && line.match(/^\s*Resolution\s*=\s*"?(\d+)"?\s*$/i);
    if (match && Number(match[1]) > 0) resolution = Number(match[1]);
  }
  const beats = Math.max(1, Math.round(delayMs / LEAD_BEAT_MS));
  const ticks = beats * resolution;
  const leadTempo = Math.round((60000 * 1000 * beats) / delayMs);

  let hasSync = false;
  let tsAtZero = false;
  let tempoAtZero = false;
  section = "";
  const out = lines.map((line) => {
    const header = line.trim().match(/^\[(.+)\]$/);
    if (header) {
      section = header[1];
      if (section === "SyncTrack") hasSync = true;
      return line;
    }
    if (section === "Song") return line;
    const event = line.match(/^(\s*)(\d+)(\s*=\s*)(\S+)(.*)$/);
    if (!event) return line;
    const [, indent, tick, eq, type, rest] = event;
    let value = rest;
    if (section === "SyncTrack") {
      if (Number(tick) === 0 && type === "TS") tsAtZero = true;
      if (Number(tick) === 0 && type === "B") tempoAtZero = true;
      // Anchors pin a tick to a time (microseconds); that time moves too.
      if (type === "A") value = rest.replace(/^(\s*)(\d+)/, (_, space, us) => `${space}${Number(us) + delayMs * 1000}`);
    }
    return `${indent}${Number(tick) + ticks}${eq}${type}${value}`;
  });

  const lead = [
    "  0 = TS 1",
    `  0 = B ${leadTempo}`,
    // Readers default to 4/4 at 120 BPM before a chart's first event.
    ...(tsAtZero ? [] : [`  ${ticks} = TS 4`]),
    ...(tempoAtZero ? [] : [`  ${ticks} = B 120000`]),
  ];
  if (hasSync) {
    const start = out.findIndex((line) => line.trim() === "[SyncTrack]");
    const open = out.findIndex((line, i) => i > start && line.trim() === "{");
    out.splice(open + 1, 0, ...lead);
  } else {
    const songEnd = out.findIndex((line, i) => i > out.findIndex((l) => l.trim() === "[Song]") && line.trim() === "}");
    out.splice(songEnd + 1, 0, "[SyncTrack]", "{", ...lead, "}");
  }
  return { chartText: out.join(eol), ticks };
}
