// Renders a stem to listen to from its separation's mel tables, off the main
// thread: the stem's share of the song's power, per mel band and frame, as a
// soft mask on the song itself (renderStem). The song comes at 44.1 kHz, twice
// the tables' rate, so the mask's frames line up at hop 1024, with the
// separation's lead-in silence in front as the tables have it.
import { decodeMelTables } from "../../../engine/lib/onnx/melTables.mjs";
import { renderStem } from "../../../engine/lib/onnx/stemRender.mjs";
import { powerDb, stemParts, stemPowers, wav16 } from "./stemTables.js";

const TABLE_RATE = 22050;
const SONG_RATE = 44100;
const HOP = 1024;
const N_FFT = 4096;

let song = null; // { key, left, right }
let tables = null; // { path, ready, decoded, powers: Map(signature -> stemPowers) }

function powersFor(entry, rowIds) {
  const signature = JSON.stringify(rowIds);
  if (!entry.powers.has(signature)) entry.powers.set(signature, stemPowers(entry.decoded, rowIds));
  return entry.powers.get(signature);
}

self.onmessage = async ({ data }) => {
  if (data.type === "song") {
    song = { key: data.key, left: data.left, right: data.right };
    return;
  }
  if (data.type === "tables") {
    const entry = { path: data.path, decoded: null, powers: new Map() };
    entry.ready = decodeMelTables(new Uint8Array(data.bytes)).then((decoded) => {
      entry.decoded = decoded;
    });
    tables = entry;
    return;
  }
  if (data.type !== "render") return;
  const { id, songKey, path, stem, rowIds } = data;
  try {
    const entry = tables;
    if (song?.key !== songKey || entry?.path !== path) throw new Error("The stem render lost its song.");
    await entry.ready;
    const { nMels, nFrames, mix, stems } = powersFor(entry, rowIds);
    // Stems heard together: their powers summed, one mask for all of them.
    const heardParts = stemParts(stem);
    for (const part of heardParts) {
      if (!stems[part]) throw new Error(`This separation has no ${part} stem.`);
    }
    let heard = stems[heardParts[0]];
    if (heardParts.length > 1) {
      heard = new Float32Array(heard.length);
      for (const part of heardParts) {
        const p = stems[part];
        for (let i = 0; i < heard.length; i += 1) heard[i] += p[i];
      }
    }
    const out = renderStem({
      left: song.left,
      right: song.right,
      mixDb: powerDb(mix),
      stemDb: powerDb(heard),
      nMels,
      nFrames,
      sampleRate: SONG_RATE,
      hop: HOP,
      nFft: N_FFT,
      fmax: TABLE_RATE / 2,
    });
    const wav = wav16(out.left, out.right, SONG_RATE);
    self.postMessage({ id, wav }, [wav]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
