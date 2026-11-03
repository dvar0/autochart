import { framePower } from "./songMap.mjs";
import { createSession, graphPath, sessionDevice, tensor, runSession, hardwareThreads, startStftWorkers } from "./runtime.mjs";
import { demucsOrchestration } from "./manifest.mjs";
import { stftFor, chunkShape, analyseChannel, synthesiseStream } from "./stftTasks.mjs";
import { createWorkerPool } from "./workerPool.mjs";

// Only the core network is a graph: both STFTs run in JS (stft.mjs), so the
// model folder's demucs_analysis_stft / demucs_synthesis_istft go unused.
async function loadDemucsSessions(manifest, device = "cpu", log = null) {
  const opts = { device, log };
  const load = async (role) => {
    const t0 = Date.now();
    if (log) log(`  loading ${role}`);
    const session = await createSession(graphPath(manifest, role), opts);
    if (log) log(`  ${role} ready on ${sessionDevice(session, device)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return session;
  };
  const orch = demucsOrchestration(manifest);
  const core = await load("demucs-core-network");
  const resolved = sessionDevice(core, device);
  return { stft: stftFor(orch.nfft, orch.hopLength), core, device: resolved, stftWorkers: stftWorkerCount(resolved, hardwareThreads()) };
}

// Faithful JS port of the reference Demucs-ONNX separation pipeline, with the
// STFTs computed exactly (stft.mjs): 88-116 dB per stem against PyTorch
// htdemucs_6s, where the reference's float32 DFT basis graphs got 44-81 dB.

const tick = (times, key, since) => {
  times[key] = (times[key] || 0) + performance.now() - since;
  return performance.now();
};

// Run STFT -> core -> inverse STFT on ONE chunk padded to segmentLength.
// mixFlat: Float32Array (B*C=2, L). Returns { data: (1, S, C, L), dims }.
async function runSegment(mixFlat, B, C, L, sessions, orch, times = {}) {
  let t = performance.now();
  if (L !== orch.segmentLength) {
    throw new Error(
      `Demucs core ONNX only valid at segmentLength=${orch.segmentLength}; got L=${L}. ` +
      `Refusing to run core (silent corruption off-shape).`
    );
  }
  const shape = chunkShape(orch);
  const { le, freq } = shape;
  const bins = freq * le;
  // core inputs: real [2, 2048, le], imag [2, 2048, le], mix [1, 2, L]
  const real = new Float32Array(B * C * bins);
  const imag = new Float32Array(B * C * bins);
  for (let r = 0; r < B * C; r += 1) {
    analyseChannel(sessions.stft, mixFlat.subarray(r * L, (r + 1) * L), shape, real.subarray(r * bins, (r + 1) * bins), imag.subarray(r * bins, (r + 1) * bins));
  }
  t = tick(times, "analysis", t);
  const coreOut = await runSession(sessions.core, {
    real: tensor("float32", real, [B * C, freq, le]),
    imag: tensor("float32", imag, [B * C, freq, le]),
    mix: tensor("float32", mixFlat, [B, C, L]),
  });
  const zr = await coreOut.zout_real.getData(true); // (1,S,2,2048,le)
  const zi = await coreOut.zout_imag.getData(true);
  const xt = await coreOut.xt.getData(true); // (1,S,2,L)
  t = tick(times, "core", t);
  // Rows are stem-major then channel (s*C + c), as the core lays them out.
  const S = orch.sources.length;
  const out = new Float32Array(B * S * C * L);
  for (let r = 0; r < B * S * C; r += 1) {
    synthesiseStream(sessions.stft, zr.subarray(r * bins, (r + 1) * bins), zi.subarray(r * bins, (r + 1) * bins), xt.subarray(r * L, (r + 1) * L), shape, out.subarray(r * L, (r + 1) * L));
  }
  tick(times, "synthesis", t);
  return { data: out, dims: [B, S, C, L] };
}

// TensorChunk.padded port (demucs apply.py (upstream)): center chunk inside target_length, zero-pad overhang.
function chunkPadded(mixFlat, B, C, totalLength, offset, chunkLength, targetLength) {
  const delta = targetLength - chunkLength;
  if (delta < 0) throw new Error(`chunk longer than target: ${chunkLength} > ${targetLength}`);
  const start = offset - (delta >> 1);
  const end = start + targetLength;
  const correctStart = Math.max(0, start);
  const correctEnd = Math.min(totalLength, end);
  const padLeft = correctStart - start;
  const padRight = end - correctEnd;
  const out = new Float32Array(B * C * targetLength);
  for (let r = 0; r < B * C; r += 1) {
    const srcOff = r * totalLength + correctStart;
    const dstOff = r * targetLength + padLeft;
    const copyLen = correctEnd - correctStart;
    if (copyLen > 0) out.set(mixFlat.subarray(srcOff, srcOff + copyLen), dstOff);
  }
  return out;
}

// center_trim port
function centerTrim(arr, length) {
  const cur = arr.length;
  const delta = cur - length;
  if (delta < 0) throw new Error(`tensor smaller than reference: delta=${delta}`);
  if (!delta) return arr;
  const start = delta >> 1;
  return arr.subarray(start, start + length);
}

// Triangular weight vector length N, peak in the middle, normalized to max 1, raised to transitionPower.
function triangularWeights(N, transitionPower) {
  const half = N >> 1;
  const w = new Float32Array(N);
  for (let i = 0; i < half; i += 1) w[i] = i + 1;
  for (let i = 0; i < N - half; i += 1) w[half + i] = N - half - i;
  let max = 0;
  for (let i = 0; i < N; i += 1) if (w[i] > max) max = w[i];
  for (let i = 0; i < N; i += 1) {
    let v = w[i] / max;
    if (transitionPower !== 1) v = Math.pow(v, transitionPower);
    w[i] = v;
  }
  return w;
}

// STFT workers for separate(). While the core network runs a chunk, the
// workers do the analysis STFT of the next chunks and the inverse STFT of
// the last ones. The core gets most of the CPU on a CPU run, so it keeps its
// threads and the workers fill the time it leaves idle.
function stftWorkerCount(device, threads) {
  if (!(threads > 1)) return 0;
  return device === "cpu" ? Math.min(4, threads) : Math.min(8, threads - 1);
}

// How many chunks the workers run ahead of the core (analysis) and behind it
// (inverse STFT). Each chunk behind holds its spectrograms until it is done.
const AHEAD = 2;
const BEHIND = 2;

// Marks a promise as handled, so one left behind when separate() throws
// doesn't end the process; whoever awaits it still gets the rejection.
const quiet = (promise) => {
  promise.catch(() => {});
  return promise;
};

// Separate a stereo mix into the model's sources.
// mixFlat: Float32Array length 2*L, planar (all left samples, then all right).
// Returns [{ name, left, right }] in orch.sources order.
// sessions.stftWorkers sets how many STFT workers to use; 0 runs everything
// on this thread. Either way the stems are the same to the byte.
async function separate(mixFlat, totalLength, sessions, orch, { onProgress = null, onPower = null, log = null } = {}) {
  if (totalLength !== mixFlat.length / 2) {
    throw new Error(`mix length mismatch: ${mixFlat.length} != 2*${totalLength}`);
  }
  const B = 1;
  const C = 2;
  const S = orch.sources.length;
  const segmentLength = orch.segmentLength;
  const overlap = orch.overlap;
  const stride = Math.floor((1 - overlap) * segmentLength);
  if (stride <= 0) throw new Error(`non-positive stride: ${stride}`);

  // One buffer per source and channel: the stems come straight out of these.
  const rows = [];
  for (let r = 0; r < S * C; r += 1) rows.push(new Float32Array(totalLength));
  const sumWeight = new Float32Array(totalLength);
  const wAll = triangularWeights(segmentLength, orch.transitionPower); // length segmentLength

  const offsets = [];
  for (let off = 0; off < totalLength; off += stride) offsets.push(off);
  const nTotal = offsets.length;
  const chunkLengthOf = (i) => Math.min(totalLength - offsets[i], segmentLength);
  const paddedChunk = (i) => chunkPadded(mixFlat, B, C, totalLength, offsets[i], chunkLengthOf(i), segmentLength);
  const t0 = Date.now();
  const times = {};

  // Overlap-adds chunk i's stems (S*C rows of segmentLength), in chunk order.
  const addChunk = (i, segData) => {
    const offset = offsets[i];
    const chunkLength = chunkLengthOf(i);
    // center_trim each (B,S,C) row to chunkLength
    // out[..., offset:end] += w_clipped * seg_out_trim
    const end = Math.min(offset + segmentLength, totalLength);
    const targetLen = end - offset;
    const wClipped = wAll.subarray(0, chunkLength); // length chunkLength
    const trimStart = (segmentLength - chunkLength) >> 1;
    for (let r = 0; r < S * C; r += 1) {
      const segRow = r * segmentLength + trimStart;
      const row = rows[r];
      for (let t = 0; t < targetLen; t += 1) {
        row[offset + t] += wClipped[t] * segData[segRow + t];
      }
    }
    // sum_weight[offset:end] += w_clipped[:targetLen]
    for (let t = 0; t < targetLen; t += 1) sumWeight[offset + t] += wClipped[t];

    // Nothing later touches the audio before the next segment's start, so this
    // stretch of each source is already final.
    if (onPower) {
      const stretchEnd = i + 1 < nTotal ? offsets[i + 1] : totalLength;
      const power = {};
      let first = 0;
      orch.sources.forEach((name, s) => {
        const part = framePower([rows[s * C], rows[s * C + 1]], orch.sampleRate, offset, stretchEnd, { weights: sumWeight });
        power[name] = part.power;
        first = part.first;
      });
      onPower({ first, power });
    }

    const elapsed = (Date.now() - t0) / 1000;
    if (log) log(`  [seg ${i + 1}/${nTotal}] offset=${offset} chunk_len=${chunkLength} (${elapsed.toFixed(1)}s elapsed)`);
    if (onProgress) onProgress({ index: i + 1, total: nTotal, offset, chunkLength, elapsed });
  };

  let added = 0;
  const addNext = (segData) => {
    addChunk(added, segData);
    added += 1;
  };
  const workers = startStftWorkers(Math.min(sessions.stftWorkers || 0, 2 * S * C));
  if (log) log(`  separating ${nTotal} chunks${workers ? ` (${workers.length} STFT workers)` : ""}`);
  if (workers) {
    const pool = createWorkerPool(workers);
    try {
      await separateOnWorkers(pool, nTotal, paddedChunk, addNext, sessions, orch, times);
    } catch (err) {
      // A worker that fails leaves the rest of the chunks to this thread.
      if (!pool.failed) throw err;
      if (log) log(`  ${err.message}; separating chunks ${added + 1}-${nTotal} without workers`);
    } finally {
      pool.close();
    }
  }
  for (let i = added; i < nTotal; i += 1) {
    const seg = await runSegment(paddedChunk(i), B, C, segmentLength, sessions, orch, times);
    addNext(seg.data);
  }

  if (log) log(`  separation time per step: ${Object.entries(times).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(", ")}`);
  let minW = Infinity;
  for (let i = 0; i < totalLength; i += 1) if (sumWeight[i] < minW) minW = sumWeight[i];
  if (!(minW > 0)) throw new Error("overlap-add weight sum must be strictly positive everywhere");

  for (const row of rows) {
    for (let t = 0; t < totalLength; t += 1) row[t] /= sumWeight[t];
  }

  // Stems as {name, left, right} in the model's source order.
  return orch.sources.map((name, s) => ({ name, left: rows[s * C], right: rows[s * C + 1] }));
}

// separate()'s chunk loop with the STFTs on workers. The core runs the chunks
// in order on this thread and addNext gets their stems in order, so the
// callbacks fire as before, just later. times: core = the core network,
// waiting = this thread waiting on the workers.
async function separateOnWorkers(pool, nTotal, paddedChunk, addNext, sessions, orch, times) {
  const C = 2;
  const S = orch.sources.length;
  const shape = chunkShape(orch);
  const { L, le, freq } = shape;
  const bins = freq * le;
  const base = { nfft: orch.nfft, hop: orch.hopLength, shape };

  const analysis = new Map();
  const analyse = (i) => {
    const mix = paddedChunk(i);
    const channels = [];
    for (let c = 0; c < C; c += 1) {
      const row = mix.slice(c * L, (c + 1) * L);
      channels.push(pool.run({ ...base, op: "analysis", row }, [row.buffer]));
    }
    return quiet(Promise.all(channels).then((parts) => ({ mix, parts })));
  };

  const behind = [];
  const finish = async ({ streams }) => {
    const t = performance.now();
    const outs = await streams;
    times.waiting = (times.waiting || 0) + performance.now() - t;
    const segData = new Float32Array(S * C * L);
    outs.forEach(({ out }, r) => segData.set(out, r * L));
    addNext(segData);
  };

  for (let i = 0; i < nTotal; i += 1) {
    for (let j = i; j <= i + AHEAD && j < nTotal; j += 1) {
      if (!analysis.has(j)) analysis.set(j, analyse(j));
    }
    let t = performance.now();
    const { mix, parts } = await analysis.get(i);
    analysis.delete(i);
    times.waiting = (times.waiting || 0) + performance.now() - t;
    t = performance.now();
    const real = new Float32Array(C * bins);
    const imag = new Float32Array(C * bins);
    parts.forEach((part, c) => {
      real.set(part.real, c * bins);
      imag.set(part.imag, c * bins);
    });
    const coreOut = await runSession(sessions.core, {
      real: tensor("float32", real, [C, freq, le]),
      imag: tensor("float32", imag, [C, freq, le]),
      mix: tensor("float32", mix, [1, C, L]),
    });
    const zr = await coreOut.zout_real.getData(true);
    const zi = await coreOut.zout_imag.getData(true);
    const xt = await coreOut.xt.getData(true);
    times.core = (times.core || 0) + performance.now() - t;
    const streams = [];
    for (let r = 0; r < S * C; r += 1) {
      const task = {
        ...base,
        op: "synthesis",
        zr: zr.slice(r * bins, (r + 1) * bins),
        zi: zi.slice(r * bins, (r + 1) * bins),
        xt: xt.slice(r * L, (r + 1) * L),
      };
      streams.push(pool.run(task, [task.zr.buffer, task.zi.buffer, task.xt.buffer]));
    }
    behind.push({ streams: quiet(Promise.all(streams)) });
    if (behind.length > BEHIND) await finish(behind.shift());
  }
  while (behind.length) await finish(behind.shift());
}

// Sum model sources into the cached stems per orch.stemFold (htdemucs_6s:
// other = other + piano, in float32 like the training cache). Stems that map
// to a single source pass through untouched, so a fold-free model is a no-op.
function foldStems(stems, orch) {
  const byName = new Map(stems.map((stem) => [stem.name, stem]));
  const stemNames = Array.isArray(orch.stems) && orch.stems.length ? orch.stems : stems.map((stem) => stem.name);
  return stemNames.map((name) => {
    const parts = (orch.stemFold && orch.stemFold[name]) || [name];
    const sources = parts.map((part) => {
      const source = byName.get(part);
      if (!source) throw new Error(`Demucs output is missing source ${part} for stem ${name}.`);
      return source;
    });
    if (sources.length === 1) return { name, left: sources[0].left, right: sources[0].right };
    const left = Float32Array.from(sources[0].left);
    const right = Float32Array.from(sources[0].right);
    for (const source of sources.slice(1)) {
      for (let i = 0; i < left.length; i += 1) left[i] += source.left[i];
      for (let i = 0; i < right.length; i += 1) right[i] += source.right[i];
    }
    return { name, left, right };
  });
}

export {
  loadDemucsSessions,
  separate,
  foldStems,
  triangularWeights,
  runSegment,
  chunkPadded,
  centerTrim,
  stftWorkerCount,
};