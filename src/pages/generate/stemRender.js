// Stems to listen to, made from a separation's mel tables in a worker
// (stemRender.worker.js). Separations keep only their tables unless "keep
// stems" is on, so playing a stem never separates the song again.
import StemRenderWorker from "./stemRender.worker.js?worker&inline";
import { readEngineCacheFile } from "../../services/generation.js";

const SONG_RATE = 44100;
const CACHE_SIZE = 4;

let worker = null;
let nextId = 1;
const pending = new Map();
// What the worker holds now; renders run one at a time so these stay true.
let workerSongKey = "";
let workerTablesPath = "";
let chain = Promise.resolve();
const songIds = new WeakMap();
let songCount = 0;
const results = new Map();

function failAll(message) {
  for (const { reject } of pending.values()) reject(new Error(message));
  pending.clear();
}

function stemWorker() {
  if (!worker) {
    worker = new StemRenderWorker();
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.wav);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      worker.terminate();
      worker = null;
      workerSongKey = "";
      workerTablesPath = "";
      failAll(event.message || "The stem render stopped.");
    };
  }
  return worker;
}

// The song at 44.1 kHz with the lead-in's silence in front, as the tables were made.
async function decodeSong(bytes, leadInSeconds) {
  const ctx = new OfflineAudioContext(2, 1, SONG_RATE);
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  const pad = Math.max(0, Math.round(leadInSeconds * SONG_RATE));
  const left = new Float32Array(pad + decoded.length);
  const right = new Float32Array(pad + decoded.length);
  left.set(decoded.getChannelData(0), pad);
  right.set(decoded.getChannelData(decoded.numberOfChannels > 1 ? 1 : 0), pad);
  return { left, right };
}

async function render({ songBytes, songKey, leadInSeconds, tablesPath, rows, stem }) {
  const target = stemWorker();
  if (workerSongKey !== songKey) {
    const { left, right } = await decodeSong(songBytes, leadInSeconds);
    target.postMessage({ type: "song", key: songKey, left, right }, [left.buffer, right.buffer]);
    workerSongKey = songKey;
  }
  if (workerTablesPath !== tablesPath) {
    const bytes = await readEngineCacheFile(tablesPath);
    target.postMessage({ type: "tables", path: tablesPath, bytes });
    workerTablesPath = tablesPath;
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({
      type: "render", id, songKey, path: tablesPath, stem,
      rowIds: rows.map((row) => row.id),
    });
  });
}

// Resolves to WAV bytes (a copy each time; callers may hand it to decoders
// that take it over).
export async function renderStemWav({ songBytes, leadInSeconds = 0, tablesPath, rows, stem }) {
  if (!songIds.has(songBytes)) songIds.set(songBytes, ++songCount);
  const songKey = `${songIds.get(songBytes)}:${leadInSeconds}`;
  const key = `${songKey}|${tablesPath}|${stem}`;
  let result = results.get(key);
  if (result) {
    results.delete(key);
  } else {
    const job = { songBytes, songKey, leadInSeconds, tablesPath, rows, stem };
    result = chain.then(() => render(job));
    chain = result.catch(() => {});
    result.catch(() => results.delete(key));
  }
  results.set(key, result);
  while (results.size > CACHE_SIZE) results.delete(results.keys().next().value);
  return (await result).slice(0);
}
