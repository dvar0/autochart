#!/usr/bin/env node
"use strict";

// The browser engine decodes a song at the rate its header names, so the
// browser never resamples it. A wrong rate makes the browser resample, and a
// low one throws away the top of the song. Formats no browser decodes are
// named when the song is picked, and a file that fails to decode is counted
// by its kind. Fixtures come from the ffmpeg on PATH (or
// $FFMPEG).

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { audioContainer, sniffSampleRate, unsupportedAudioFormat } = require("../engine/web/audio.mjs");

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autochart-audio-rates-"));

function make(name, rate, args) {
  const out = path.join(dir, name);
  execFileSync(FFMPEG, [
    "-nostdin", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=440:duration=3:sample_rate=${rate}`,
    "-ac", "2", ...args, out,
  ]);
  return fs.readFileSync(out);
}

async function main() {
  const cases = [
    ["wav.wav", 48000, [], 48000],
    ["flac.flac", 96000, [], 96000],
    ["vorbis.ogg", 32000, ["-c:a", "libvorbis"], 32000],
    ["opus.opus", 44100, ["-c:a", "libopus"], 48000],
    ["mp3.mp3", 44100, ["-c:a", "libmp3lame"], 44100],
    ["mp3-mpeg2.mp3", 22050, ["-c:a", "libmp3lame", "-ac", "1"], 22050],
    ["mp3-no-id3.mp3", 48000, ["-c:a", "libmp3lame", "-id3v2_version", "0", "-write_xing", "0"], 48000],
    ["adts.aac", 44100, ["-c:a", "aac"], 44100],
    ["aac.m4a", 44100, ["-c:a", "aac"], 44100],
    ["aac-48k.m4a", 48000, ["-c:a", "aac", "-movflags", "+faststart"], 48000],
    ["aac.mov", 48000, ["-c:a", "aac"], 48000],
    ["mp3-in.mp4", 44100, ["-c:a", "libmp3lame"], 44100],
    ["vorbis.mkv", 44100, ["-c:a", "libvorbis"], 44100],
    ["aac.mkv", 22050, ["-c:a", "aac"], 22050],
    ["opus.webm", 44100, ["-c:a", "libopus"], 48000],
  ];
  for (const [name, rate, args, expected] of cases) {
    assert.equal(sniffSampleRate(make(name, rate, args)), expected, name);
  }

  // Past 256 MB, bit positions in the file overflow 32-bit shifts: a long
  // video's AAC config must still read right.
  {
    const small = make("aac-moov-last.mp4", 48000, ["-c:a", "aac"]);
    const ftypSize = small.readUInt32BE(0);
    const padSize = 300 * 1024 * 1024;
    const pad = Buffer.alloc(8);
    pad.writeUInt32BE(padSize, 0);
    pad.write("free", 4, "latin1");
    const big = Buffer.concat([small.subarray(0, ftypSize), pad, Buffer.alloc(padSize - 8), small.subarray(ftypSize)]);
    assert.equal(sniffSampleRate(big), 48000, "AAC config past 256 MB");
  }

  // Stray sync bytes aren't MPEG audio, and unknown files stay unknown.
  {
    const noise = Buffer.alloc(4096, 0);
    noise[100] = 0xff;
    noise[101] = 0xfb;
    noise[102] = 0x90;
    assert.equal(sniffSampleRate(noise), null, "a lone frame header");
    assert.equal(sniffSampleRate(Buffer.from("not a song at all, just some text here")), null, "text");
  }

  // Formats every browser refuses are named from the header; the rest pass.
  const formats = [
    ["aiff.aiff", ["-c:a", "pcm_s16be"], "aiff"],
    ["aifc.aif", ["-c:a", "pcm_s16le", "-f", "aiff"], "aiff"],
    ["alac.m4a", ["-c:a", "alac"], "alac"],
    ["alac-faststart.m4a", ["-c:a", "alac", "-movflags", "+faststart"], "alac"],
    ["wma.wma", ["-c:a", "wmav2"], "wma"],
    ["raw.ac3", ["-c:a", "ac3"], "ac3"],
    ["ac3.mp4", ["-c:a", "ac3"], "dolby"],
    ["eac3.mp4", ["-c:a", "eac3"], "dolby"],
    ["adpcm.wav", ["-c:a", "adpcm_ms"], "adpcm"],
    ["pcm.wav", [], null],
    ["mulaw.wav", ["-c:a", "pcm_mulaw"], null],
    ["float.wav", ["-c:a", "pcm_f32le"], null],
    ["aac.m4a", ["-c:a", "aac"], null],
    ["mp3.mp3", ["-c:a", "libmp3lame"], null],
    ["flac.flac", [], null],
    ["opus.webm", ["-c:a", "libopus"], null],
  ];
  for (const [name, args, expected] of formats) {
    const blob = new Blob([make(`format-${name}`, 44100, args)]);
    assert.equal(await unsupportedAudioFormat(blob), expected, name);
  }
  assert.equal(await unsupportedAudioFormat(new Blob([])), null, "empty file");

  // A failed decode is counted by the file's kind, read from its header.
  const kinds = [
    ["mp3.mp3", ["-c:a", "libmp3lame"], "mp3"],
    ["mp3-no-id3.mp3", ["-c:a", "libmp3lame", "-id3v2_version", "0", "-write_xing", "0"], "mp3"],
    ["adts.aac", ["-c:a", "aac"], "aac"],
    ["aac.m4a", ["-c:a", "aac"], "mp4"],
    ["wav.wav", [], "wav"],
    ["flac.flac", [], "flac"],
    ["vorbis.ogg", ["-c:a", "libvorbis"], "ogg"],
    ["opus.webm", ["-c:a", "libopus"], "matroska"],
    ["aiff.aiff", ["-c:a", "pcm_s16be"], "aiff"],
    ["wma.wma", ["-c:a", "wmav2"], "wma"],
    ["raw.ac3", ["-c:a", "ac3"], "ac3"],
  ];
  for (const [name, args, expected] of kinds) {
    assert.equal(audioContainer(make(`kind-${name}`, 44100, args)), expected, name);
  }
  assert.equal(audioContainer(Buffer.from("not a song at all, just some text here")), "unknown", "text");
  assert.equal(audioContainer(Buffer.alloc(0)), "unknown", "empty");

  console.log("web audio checks passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
