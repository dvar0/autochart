// Generate a chart in the browser: the desktop engine's stages over audio held
// in memory. Each stage frees its models when done; the browser has a few GB
// at most and the stages' models together are larger than that on the CPU path.

import { demucsOrchestration } from "../lib/onnx/manifest.mjs";
import { beatOrchestration } from "../lib/onnx/beatDetect.mjs";
import { separateStems, detectTiming, transcribe, transcriberChannels, needsStems, chartFromTokens } from "../lib/onnx/pipeline.mjs";
import { releaseSessions } from "./host.mjs";
import { stereoAt, ffmpegMonoAt, averageMonoAt } from "./audio.mjs";
import { MAP_RATE, mixLevels, roundTimes } from "../lib/onnx/songMap.mjs";

const TRANSCRIBER_RATE = 22050;
const CHART_RESOLUTION = 192;

// audio: { left, right, sampleRate } at the file's own rate (see audio.mjs).
// settings: the desktop engine's normalized transcriber settings.
export async function generateChart({ manifest, audio, settings, knobNames, device = "auto", transcriberDevice = device, metadata = {}, onEvent = () => {} }) {
  const times = {};
  const log = (stage) => (message) => onEvent({ type: "log", stage, message });
  const stageDevice = (stage) => (dev) => onEvent({ type: "stage", stage, status: "running", device: dev });
  const timed = async (stage, run) => {
    const t0 = performance.now();
    onEvent({ type: "stage", stage, status: "running" });
    const out = await run();
    times[stage] = (performance.now() - t0) / 1000;
    onEvent({ type: "stage", stage, status: "completed", seconds: times[stage] });
    return out;
  };

  onEvent({
    type: "song_map",
    kind: "mix",
    rate: MAP_RATE,
    seconds: audio.left.length / audio.sampleRate,
    levels: mixLevels([audio.left, audio.right], audio.sampleRate),
  });
  const orch = demucsOrchestration(manifest);
  const separation = !needsStems(manifest) ? { stems: [] } : await timed("demucs", async () => {
    const stereo = stereoAt(audio, orch.sampleRate);
    const out = await separateStems({
      manifest, device, left: stereo.left, right: stereo.right,
      log: log("demucs"),
      onDevice: stageDevice("demucs"),
      onProgress: ({ index, total }) => onEvent({ type: "stage", stage: "demucs", status: "running", progress: total ? index / total : 0 }),
      onStems: ({ from, levels }) => onEvent({ type: "song_map", kind: "stems", from, levels }),
    });
    await releaseSessions();
    return out;
  });

  const timing = await timed("timing", async () => {
    const mono = ffmpegMonoAt(audio, beatOrchestration(manifest).sampleRate);
    const out = await detectTiming({
      manifest, device, mono,
      smooth: Boolean(settings.smoothing?.enabled),
      log: log("timing"),
      onDevice: stageDevice("timing"),
      onChunk: ({ index, total, beats, downbeats }) => {
        onEvent({ type: "song_map", kind: "beats", from: index, beats: roundTimes(beats), downbeats: roundTimes(downbeats) });
        onEvent({ type: "stage", stage: "timing", status: "running", progress: total ? index / total : 0 });
      },
    });
    await releaseSessions();
    onEvent({ type: "song_map", kind: "beats", final: true, beats: roundTimes(out.beats.beatTimes), downbeats: roundTimes(out.beats.downbeatTimes) });
    return out;
  });

  const transcription = await timed("transcription", async () => {
    const stemMonos = {};
    for (const name of transcriberChannels(manifest).filter((channel) => channel !== "full")) {
      const stem = separation.stems.find((s) => s.name === name);
      if (!stem) throw new Error(`transcription: missing ${name} stem`);
      stemMonos[name] = averageMonoAt(stem.left, stem.right, separation.sampleRate, TRANSCRIBER_RATE);
    }
    const fullMono = averageMonoAt(audio.left, audio.right, audio.sampleRate, TRANSCRIBER_RATE);
    const out = await transcribe({
      manifest, device: transcriberDevice, settings, knobNames,
      fullMono, stemMonos,
      audioDuration: fullMono.length / TRANSCRIBER_RATE,
      beatTimes: timing.beats.beatTimes,
      resolution: CHART_RESOLUTION,
      log: log("transcription"),
      onDevice: stageDevice("transcription"),
      onPartial: (partial) => onEvent({ type: "partial_chart", ...partial }),
    });
    await releaseSessions();
    return out;
  });

  const chart = chartFromTokens({
    tokens: transcription.tokens,
    structure: transcription.structure,
    nBeats: transcription.nBeats,
    resolution: CHART_RESOLUTION,
    syncLines: transcription.syncLines,
    metadata: {
      title: metadata.title || "Untitled",
      artist: metadata.artist || "Unknown Artist",
      charter: metadata.charter || "Autochart",
    },
    difficulty: settings.difficulty,
  });

  return {
    chartText: chart.text,
    noteLineCount: chart.noteLineCount,
    tokens: transcription.tokens,
    beats: timing.beats,
    stems: separation.stems,
    devices: { demucs: separation.device, timing: timing.device, transcriber: transcription.device },
    seconds: times,
  };
}
