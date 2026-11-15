// Plays a separation's stems live on the Separation stage: the song goes
// through the stem's mask as it plays (stemStream.js), a few chunks ahead, so
// picking a stem, the mix or a spot in the song starts right away. Switching
// starts a new stream from the moment being heard and crossfades into it.
//
// Looks enough like an <audio> element for the stage's transport: play(),
// pause(), currentTime, duration, paused, volume, muted, and "play", "pause",
// "ended" and "timeupdate" events.
import { createStemStream, STREAM_RATE } from "./stemStream.js";

const CHUNK = 8192; // samples per scheduled buffer (~0.19 s)
const AHEAD = 0.6; // seconds of audio kept scheduled
// A hidden window's timers may only fire about once a second.
const AHEAD_HIDDEN = 2.5;
const START_DELAY = 0.04; // seconds between a request and its first sample
const FADE = 0.025; // crossfade between streams
const TICK_MS = 50;

const songs = new WeakMap();

// The song's bytes decoded once at 44.1 kHz, the rate the tables line up with.
export function decodeSongPcm(bytes) {
  if (!songs.has(bytes)) {
    const pending = (async () => {
      const ctx = new OfflineAudioContext(2, 1, STREAM_RATE);
      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      const left = decoded.getChannelData(0);
      const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
      return { left, right };
    })();
    pending.catch(() => songs.delete(bytes));
    songs.set(bytes, pending);
  }
  return songs.get(bytes);
}

export default class StemLivePlayer extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.master = null;
    this.source = null; // { song, leadIn, powers }
    this.heard = null; // row ids, or null for the mix
    this.session = null;
    this.timer = 0;
    this.pausedAt = 0;
    this._volume = 1;
    this._muted = false;
  }

  get ready() {
    return Boolean(this.source);
  }

  get paused() {
    return !this.session;
  }

  get duration() {
    return this.source ? (this.source.leadIn + this.source.song.left.length) / STREAM_RATE : 0;
  }

  get currentTime() {
    const session = this.session;
    if (!session) return this.pausedAt;
    const elapsed = Math.max(0, this.ctx.currentTime - session.startTime);
    return Math.min(this.duration, session.startSample / STREAM_RATE + elapsed);
  }

  set currentTime(value) {
    const time = Math.max(0, Math.min(this.duration || 0, Number(value) || 0));
    if (this.session) this.restart(time);
    else this.pausedAt = time;
    this.emit("timeupdate");
  }

  get volume() {
    return this._volume;
  }

  set volume(value) {
    this._volume = Math.max(0, Math.min(1, Number(value) || 0));
    this.applyVolume();
  }

  get muted() {
    return this._muted;
  }

  set muted(value) {
    this._muted = Boolean(value);
    this.applyVolume();
  }

  // song: { left, right } at 44.1 kHz; leadIn: seconds of silence the
  // separation put in front; powers: stemTables.stemPowers output. A playing
  // stream carries on from the same moment.
  setSource({ song, leadIn = 0, powers }) {
    const next = { song, leadIn: Math.round(leadIn * STREAM_RATE), powers };
    const same = this.source && this.source.song === next.song && this.source.leadIn === next.leadIn && this.source.powers === next.powers;
    if (same) return;
    this.source = next;
    if (this.session) this.restart(this.currentTime);
    else this.pausedAt = Math.min(this.pausedAt, this.duration);
  }

  // "mix", or row ids joined with "+".
  setHeard(stem) {
    const next = !stem || stem === "mix" ? null : String(stem).split("+").filter(Boolean);
    if (String(next) === String(this.heard)) return;
    this.heard = next;
    if (this.session) this.restart(this.currentTime);
  }

  async play() {
    if (!this.source) throw new Error("The stems aren't ready yet.");
    this.ensureContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (this.session) return;
    const from = this.pausedAt >= this.duration - 0.05 ? 0 : this.pausedAt;
    this.restart(from);
    this.emit("play");
  }

  pause() {
    if (!this.session) return;
    this.pausedAt = this.currentTime;
    this.endSession(this.session, this.ctx.currentTime);
    this.session = null;
    this.stopTimer();
    this.emit("pause");
    this.emit("timeupdate");
  }

  dispose() {
    if (this.session) this.endSession(this.session, this.ctx.currentTime);
    this.session = null;
    this.stopTimer();
    this.source = null;
    this.ctx?.close?.().catch?.(() => {});
    this.ctx = null;
  }

  // internals

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  ensureContext() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: STREAM_RATE, latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.applyVolume();
  }

  applyVolume() {
    if (this.master) this.master.gain.value = this._muted ? 0 : this._volume;
  }

  // A new stream from `time` (seconds), faded in over whatever was playing.
  restart(time) {
    const { ctx } = this;
    // On a sample frame, so the chunks after it line up exactly.
    const startTime = Math.ceil((ctx.currentTime + START_DELAY) * STREAM_RATE) / STREAM_RATE;
    const startSample = Math.round(Math.max(0, time) * STREAM_RATE);
    const gain = ctx.createGain();
    gain.connect(this.master);
    const old = this.session;
    if (old) {
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(1, startTime + FADE);
      this.endSession(old, startTime);
    }
    this.session = {
      gain,
      sources: [],
      startTime,
      startSample,
      next: startSample,
      stream: createStemStream({ ...this.source, heard: this.heard, start: startSample }),
    };
    this.pump();
    this.startTimer();
  }

  endSession(session, at) {
    const when = Math.max(at, this.ctx.currentTime);
    session.gain.gain.cancelScheduledValues(when);
    session.gain.gain.setValueAtTime(session.gain.gain.value, when);
    session.gain.gain.linearRampToValueAtTime(0, when + FADE);
    for (const source of session.sources) {
      try {
        source.stop(when + FADE + 0.01);
      } catch {
        // already stopped
      }
    }
    setTimeout(() => session.gain.disconnect(), (when - this.ctx.currentTime + FADE + 0.2) * 1000);
  }

  // Schedules chunks until AHEAD seconds past the moment being heard.
  pump() {
    const session = this.session;
    if (!session) return;
    const { ctx } = this;
    const { stream } = session;
    const ahead = typeof document !== "undefined" && document.hidden ? AHEAD_HIDDEN : AHEAD;
    const until = Math.min(stream.total, Math.round((this.currentTime + ahead) * STREAM_RATE));
    while (session.next < until) {
      const count = Math.min(CHUNK, stream.total - session.next);
      const { left, right } = stream.render(count);
      const buffer = ctx.createBuffer(2, count, STREAM_RATE);
      buffer.copyToChannel(left, 0);
      buffer.copyToChannel(right, 1);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(session.gain);
      const at = session.startTime + (session.next - session.startSample) / STREAM_RATE;
      node.start(Math.max(at, ctx.currentTime));
      node.onended = () => {
        const i = session.sources.indexOf(node);
        if (i >= 0) session.sources.splice(i, 1);
      };
      session.sources.push(node);
      session.next += count;
    }
  }

  startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.session) return this.stopTimer();
      if (this.currentTime >= this.duration - 0.001) {
        this.session = null;
        this.pausedAt = this.duration;
        this.stopTimer();
        this.emit("timeupdate");
        this.emit("pause");
        this.emit("ended");
        return undefined;
      }
      this.pump();
      this.emit("timeupdate");
      return undefined;
    }, TICK_MS);
  }

  stopTimer() {
    clearInterval(this.timer);
    this.timer = 0;
  }
}
