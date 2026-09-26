"use strict";

const { spawn } = require("child_process");
const { writeStereoWav } = require("./wavWrite.cjs");

const { resolveFfmpegPath } = require("../../../electron/ffmpegPath.cjs");

function spawnFfmpeg(args, { input = null } = {}) {
  const bin = resolveFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") reject(new Error("ffmpeg not found; install ffmpeg or set AUTOCHART_FFMPEG_PATH."));
      else reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg failed (exit ${code}).${stderr.trim() ? ` ${stderr.trim().slice(-800)}` : ""}`));
    });
    child.stdin.end(input == null ? undefined : input);
  });
}

// Decode audio to planar? No: ffmpeg f32le is interleaved. Return Float32Array (interleaved L,R,L,R...).
async function decodePcmF32(audioPath, { sampleRate = 44100, channels = 2 } = {}) {
  return decodePcmF32Input(audioPath, { sampleRate, channels });
}

async function decodePcmF32Buffer(input, { sampleRate = 44100, channels = 2 } = {}) {
  return decodePcmF32Input("pipe:0", { sampleRate, channels, input });
}

async function decodePcmF32Input(inputPath, { sampleRate, channels, input = null } = {}) {
  const buf = await spawnFfmpeg([
    "-hide_banner",
    "-loglevel", "error",
    "-i", inputPath,
    "-vn",
    "-ar", String(sampleRate),
    "-ac", String(channels),
    "-f", "f32le",
    "-",
  ], { input });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

async function stereoFromInterleaved(interleaved, sampleRate) {
  const frames = Math.floor(interleaved.length / 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    left[i] = interleaved[i * 2];
    right[i] = interleaved[i * 2 + 1];
  }
  return { left, right, length: frames, sampleRate, channels: 2 };
}

async function decodeStereoF32(audioPath, { sampleRate = 44100 } = {}) {
  return stereoFromInterleaved(await decodePcmF32(audioPath, { sampleRate, channels: 2 }), sampleRate);
}

async function decodeStereoF32Buffer(input, { sampleRate = 44100 } = {}) {
  return stereoFromInterleaved(
    await decodePcmF32Buffer(input, { sampleRate, channels: 2 }),
    sampleRate
  );
}

// ffprobe is not bundled. Count low-rate mono samples to determine duration
// without retaining a full-rate audio buffer.
async function decodeDurationSeconds(audioPath, { sampleRate = 1000 } = {}) {
  const samples = await decodePcmF32(audioPath, { sampleRate, channels: 1 });
  return samples.length / sampleRate;
}

// Decode any audio file to a mono Float32Array at `sampleRate`.
// ffmpeg `-ac 1` (mono downmix) produces a single-channel f32le stream.
// Used by the beat-detection stage (mono 22050 f32). Returns Float32Array(length).
async function decodeMono(audioPath, { sampleRate = 22050 } = {}) {
  return decodePcmF32(audioPath, { sampleRate, channels: 1 });
}

module.exports = {
  resolveFfmpegPath,
  decodePcmF32,
  decodePcmF32Buffer,
  decodeDurationSeconds,
  decodeMono,
  decodeStereoF32,
  decodeStereoF32Buffer,
  writeStereoWav,
  spawnFfmpeg,
};