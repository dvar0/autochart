#!/usr/bin/env node
"use strict";

// Original procedural test music: no recordings, samples, or external assets.
// The score, synthesizer, and generated audio use the repository's AGPL-3.0-or-later license.
const fs = require("fs");
const path = require("path");

const rate = 22050;
const seconds = 30;
const samples = new Float64Array(rate * seconds);
let randomState = 20260904;
function noise() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 2147483648 - 1;
}
function mix(start, duration, voice) {
  const offset = Math.round(start * rate);
  for (let i = 0; i < Math.round(duration * rate) && offset + i < samples.length; i++) {
    samples[offset + i] += voice(i / rate);
  }
}
function pluck(start, midi, amplitude, duration = 0.42) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  mix(start, duration, (t) => {
    const phase = 2 * Math.PI * frequency * t;
    const tone = Math.sin(phase) + 0.45 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase);
    return amplitude * tone * Math.min(t / 0.004, 1) * Math.exp(-7 * t) * Math.min((duration - t) / 0.02, 1);
  });
}

// 120 BPM, alternating bass roots, an arpeggiated lead, kick/snare/hi-hat.
const roots = [45, 48, 43, 50];
const melody = [12, 19, 15, 22, 19, 15, 24, 19];
for (let beat = 0; beat < 60; beat++) {
  const start = beat / 2;
  const root = roots[Math.floor(beat / 4) % roots.length];
  pluck(start, root, 0.18, 0.48);
  for (let half = 0; half < 2; half++) {
    pluck(start + half / 4, root + melody[(beat * 2 + half) % melody.length], 0.24);
    mix(start + half / 4, 0.06, (t) => 0.07 * noise() * Math.exp(-65 * t));
  }
  if (beat % 2 === 0) {
    mix(start, 0.22, (t) => 0.4 * Math.sin(2 * Math.PI * (48 * t + 1.4 * (1 - Math.exp(-35 * t)))) * Math.exp(-18 * t));
  } else {
    mix(start, 0.16, (t) => 0.2 * (noise() + 0.3 * Math.sin(2 * Math.PI * 180 * t)) * Math.exp(-25 * t));
  }
}

let peak = 0;
for (const value of samples) peak = Math.max(peak, Math.abs(value));
const wav = Buffer.alloc(44 + samples.length * 2);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); // PCM
wav.writeUInt16LE(1, 22); // mono
wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples.length * 2, 40);
for (let i = 0; i < samples.length; i++) {
  const fade = Math.min(1, i / (rate * 0.01), (samples.length - 1 - i) / (rate * 0.1));
  wav.writeInt16LE(Math.round(samples[i] / peak * 29000 * fade), 44 + i * 2);
}
const destination = path.join(__dirname, "..", "fixtures", "demo", "autochart-demo-30s.wav");
fs.writeFileSync(destination, wav);
console.log(`Created ${destination} (${seconds}s, ${rate} Hz, mono PCM16)`);
