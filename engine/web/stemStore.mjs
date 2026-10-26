// Separated stems for the browser engine, kept in the origin private file
// system (OPFS) so regenerating a song skips Demucs, like the desktop's
// separation cache. Each stem is stored as raw float32 (left then right), so
// the transcriber reads exactly what Demucs wrote. Works in the page and the
// engine worker.

const ROOT = "autochart-stems";
const PREFIX = "opfs:";
const AUDIO_PREFIX = "opfs-audio:";
// Analysis audio lives beside the stem folders, under a name no stem key can take.
const AUDIO_FOLDER = "_analysis-audio";

function safePart(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 96) || "x";
}

// One folder per song audio, source variant (lead-in), separation and stem set.
export function stemKey({ audioSha256, sourceVariantKey = "lead-in:0", separationId = "demucs_default", stemSet = "htdemucs" }) {
  return [audioSha256, sourceVariantKey, separationId, stemSet].map(safePart).join("__");
}

async function folder(key, create = false) {
  if (!globalThis.navigator?.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const stems = await root.getDirectoryHandle(ROOT, { create });
    return await stems.getDirectoryHandle(key, { create });
  } catch {
    return null;
  }
}

async function writeFile(dir, name, data) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function readFile(dir, name) {
  const handle = await dir.getFileHandle(name);
  return (await handle.getFile()).arrayBuffer();
}

// separation: { sampleRate, model, stems: [{ name, left, right }] }
export async function saveStems(key, separation) {
  const dir = await folder(key, true);
  if (!dir) return false;
  try {
    for (const stem of separation.stems) {
      const planar = new Float32Array(stem.left.length * 2);
      planar.set(stem.left, 0);
      planar.set(stem.right, stem.left.length);
      await writeFile(dir, `${safePart(stem.name)}.f32`, planar);
    }
    await writeFile(dir, "meta.json", JSON.stringify({
      sampleRate: separation.sampleRate,
      model: separation.model || null,
      length: separation.stems[0]?.left.length || 0,
      stems: separation.stems.map((stem) => stem.name),
      createdAt: Date.now(),
    }));
    return true;
  } catch {
    // Out of quota: the run goes on, the next one separates again.
    return false;
  }
}

async function readMeta(dir) {
  try {
    return JSON.parse(new TextDecoder().decode(await readFile(dir, "meta.json")));
  } catch {
    return null;
  }
}

export async function loadStems(key, names = null) {
  const dir = await folder(key);
  if (!dir) return null;
  const meta = await readMeta(dir);
  if (!meta) return null;
  const wanted = names || meta.stems;
  if (!wanted.every((name) => meta.stems.includes(name))) return null;
  try {
    const stems = [];
    for (const name of wanted) {
      const planar = new Float32Array(await readFile(dir, `${safePart(name)}.f32`));
      const length = planar.length / 2;
      stems.push({ name, left: planar.slice(0, length), right: planar.slice(length) });
    }
    return { sampleRate: meta.sampleRate, model: meta.model, stems };
  } catch {
    return null;
  }
}

export async function hasStems(key) {
  return Boolean(await storedStemNames(key));
}

// The stem names stored under a key, or null when nothing is stored there.
export async function storedStemNames(key) {
  const dir = await folder(key);
  const meta = dir && (await readMeta(dir));
  return meta ? meta.stems : null;
}

// What the app records for a separation's stems: { [stem]: { path, format, mime } }.
export function stemPaths(key, names) {
  return Object.fromEntries(names.map((name) => [name, { path: `${PREFIX}${key}/${name}`, format: "wav", mime: "audio/wav" }]));
}

export function isStemPath(path) {
  return String(path || "").startsWith(PREFIX);
}

// Stereo float audio as a 16-bit WAV.
function encodeWav16(left, right, rate) {
  const frames = left.length;
  const buffer = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + frames * 4, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * 4, true);
  const pcm = new Int16Array(buffer, 44, frames * 2);
  for (let i = 0; i < frames; i += 1) {
    pcm[2 * i] = Math.max(-1, Math.min(1, left[i])) * 0x7fff;
    pcm[2 * i + 1] = Math.max(-1, Math.min(1, right[i])) * 0x7fff;
  }
  return buffer;
}

// A stored stem as a 16-bit stereo WAV for playback.
async function readStemWav(path) {
  const [key, name] = String(path).slice(PREFIX.length).split("/");
  const dir = await folder(key);
  if (!dir) throw new Error("This stem is no longer stored in the browser.");
  const meta = await readMeta(dir);
  const planar = new Float32Array(await readFile(dir, `${safePart(name)}.f32`));
  const frames = planar.length / 2;
  return encodeWav16(planar.subarray(0, frames), planar.subarray(frames), meta?.sampleRate || 44100);
}

// A run's analysis audio (the song with its lead-in silence), kept as a WAV
// so lead-in takes play on the timeline they were charted on.
export async function saveAnalysisAudio(name, audio) {
  const dir = await folder(AUDIO_FOLDER, true);
  if (!dir) return null;
  try {
    await writeFile(dir, `${safePart(name)}.wav`, encodeWav16(audio.left, audio.right, audio.sampleRate));
    return `${AUDIO_PREFIX}${safePart(name)}`;
  } catch {
    return null;
  }
}

export function isStoredAudioPath(path) {
  return isStemPath(path) || String(path || "").startsWith(AUDIO_PREFIX);
}

// A stem or analysis audio path, as WAV bytes.
export async function readStoredAudio(path) {
  if (isStemPath(path)) return readStemWav(path);
  const dir = await folder(AUDIO_FOLDER);
  if (!dir) throw new Error("This audio is no longer stored in the browser.");
  return readFile(dir, `${String(path).slice(AUDIO_PREFIX.length)}.wav`);
}

async function directorySize(dir) {
  let bytes = 0;
  for await (const handle of dir.values()) {
    bytes += handle.kind === "file" ? (await handle.getFile()).size : await directorySize(handle);
  }
  return bytes;
}

// Stems take far more room than the songs (raw float32), so Settings can free
// them. Each song's analysis audio stays: its takes play on it.
export async function storedStemBytes() {
  try {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT);
    let bytes = 0;
    for await (const [name, handle] of root.entries()) {
      if (name !== AUDIO_FOLDER) bytes += handle.kind === "file" ? (await handle.getFile()).size : await directorySize(handle);
    }
    return bytes;
  } catch {
    return 0;
  }
}

// Removes every stored separation (songs separate again when next generated).
export async function removeStoredStems() {
  try {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT);
    const names = [];
    for await (const name of root.keys()) if (name !== AUDIO_FOLDER) names.push(name);
    for (const name of names) await root.removeEntry(name, { recursive: true });
  } catch { /* nothing stored */ }
}

export async function clearStems() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(ROOT, { recursive: true });
  } catch { /* nothing stored */ }
}
