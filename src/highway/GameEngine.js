// Owns the audio clock and visual highway animation. This transport is not a
// playable instrument: it has no keyboard, guitar, HID, gamepad, score,
// hit-window, or gameplay input support.
export class GameEngine {
  constructor(renderer) {
    this.renderer = renderer;
    this.audioCtx = null;
    this.buffer = null;
    this.visualDuration = 0;
    this.source = null;
    this.gainNode = null;
    this.muted = false;
    this.volume = 1;
    this.chartOffset = 0;
    this.chartTimeOffset = 0;
    this.notes = [];
    this._nextNote = 0;
    this.running = false;
    this.rafId = null;
    this.startCtxTime = 0;
    this.playOffset = 0;
    this.pausedSongTime = 0;
    this._clockOffset = null;
    this.onProgress = null;
    this.onEnded = null;
    this._lastProgressEmit = -1;
    this._tick = this._tick.bind(this);
  }

  async loadAudio(arrayBuffer) {
    this.buffer = await this.decodeAudio(arrayBuffer);
  }

  async decodeAudio(arrayBuffer) {
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (!this.gainNode) {
      this.gainNode = this.audioCtx.createGain();
      this._applyGain();
      this.gainNode.connect(this.audioCtx.destination);
    }
    return this.audioCtx.decodeAudioData(arrayBuffer.slice(0));
  }

  setTrack(track) {
    const at = this.songTime;
    this.chartOffset = Number(track.song?.offset) || 0;
    this.notes = (track.notes || []).map((note, index) => this._freshNote(note, index));
    const lastNote = this.notes[this.notes.length - 1];
    this.visualDuration = Math.max(0, Number(track.visualDuration) || 0, Number(track.duration) || 0, lastNote?.endTime || lastNote?.time || 0);
    this.renderer.setNotes(this.notes);
    if (!this.running) this.pausedSongTime = at;
    this._rearmNotes(this.chartTime, false);
  }

  _freshNote(note, index) {
    return { ...note, index, judged: false, result: null, ghosted: false, sustainDropped: false, sustainDropStartedAt: null, sustainHoldGraceUntil: 0, visualHeld: false };
  }
  _resetNote(note) {
    note.judged = false;
    note.result = null;
    note.ghosted = false;
    note.sustainDropped = false;
    note.sustainDropStartedAt = null;
    note.sustainHoldGraceUntil = 0;
    note.visualHeld = false;
  }
  reset() {
    for (const note of this.notes) this._resetNote(note);
    this.pausedSongTime = 0;
    this.playOffset = 0;
    this.paused = false;
    this._rearmNotes(0);
    this._emitProgress(true);
  }

  get duration() { return this.buffer ? this.buffer.duration : this.visualDuration; }
  get _sync() {
    const baseLatency = Number(this.audioCtx?.baseLatency) || 0;
    const outputLatency = Number(this.audioCtx?.outputLatency) || 0;
    return -(baseLatency + outputLatency) - this.chartOffset;
  }
  get songTime() {
    if (!this.running || !this.audioCtx) return this.pausedSongTime;
    if (this._clockOffset !== null) return performance.now() / 1000 + this._clockOffset;
    return this._rawSongTime();
  }
  _rawSongTime() {
    // The source is scheduled ahead to avoid audio underruns. Hold the visual
    // clock at the requested position until it starts; never rewind on play.
    return Math.max(0, this.audioCtx.currentTime - this.startCtxTime) + this.playOffset + this._sync;
  }
  _updateClock() {
    if (!this.running || !this.audioCtx) return;
    if (this.audioCtx.currentTime < this.startCtxTime) {
      this._clockOffset = null;
      return;
    }
    const offset = this._rawSongTime() - performance.now() / 1000;
    if (this._clockOffset === null || Math.abs(offset - this._clockOffset) > 0.08) {
      this._clockOffset = offset;
      return;
    }
    const error = offset - this._clockOffset;
    this._clockOffset += Math.max(-0.002, Math.min(0.002, error * 0.1));
  }
  setChartTimeOffset(seconds) {
    const n = Number(seconds);
    this.chartTimeOffset = Number.isFinite(n) ? n : 0;
  }
  get chartTime() { return this.songTime - this.chartTimeOffset; }

  _startSource(offset) {
    if (!this.buffer || !this.audioCtx) return;
    this.source = this.audioCtx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.gainNode || this.audioCtx.destination);
    const startAt = this.audioCtx.currentTime + 0.1;
    this.source.start(startAt, Math.max(0, offset));
    this.startCtxTime = startAt;
    this.playOffset = Math.max(0, offset);
    this._clockOffset = null;
  }
  _stopSource() {
    if (!this.source) return;
    try { this.source.stop(); } catch { /* already stopped */ }
    this.source.disconnect();
    this.source = null;
  }
  async play() {
    if (!this.buffer || this.running) return;
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
    if (this.pausedSongTime >= this.duration) this.seek(0);
    this._startSource(Math.min(Math.max(0, this.pausedSongTime - this._sync), this.duration));
    this.paused = false;
    this.running = true;
    this.rafId = requestAnimationFrame(this._tick);
  }
  pause() {
    if (!this.running) return;
    this.pausedSongTime = this.songTime;
    this.paused = true;
    this._haltLoop();
    this.renderer.draw(this.chartTime);
    this._emitProgress(true);
  }
  togglePause() { if (this.running) this.pause(); else this.play(); }

  seek(globalTime) {
    const t = Math.min(Math.max(0, Number(globalTime) || 0), this.duration);
    this.pausedSongTime = t;
    this._rearmNotes(t - this.chartTimeOffset);
    if (this.running) {
      this._stopSource();
      this._startSource(Math.min(Math.max(0, t - this._sync), this.duration));
    } else this.renderer.draw(t - this.chartTimeOffset);
    this._emitProgress(true);
  }

  _rearmNotes(chartTime, clearEffects = true) {
    if (clearEffects) this.renderer.clearEffects?.();
    this._nextNote = 0;
    for (const note of this.notes) {
      this._resetNote(note);
      if (note.time < chartTime) {
        this._nextNote++;
        note.judged = true;
        note.result = "perfect";
        note.visualHeld = note.sustain > 0 && note.endTime > chartTime;
      }
    }
  }
  _advanceVisualNotes(chartTime) {
    // Tracks are time sorted. Only visit newly crossed notes each frame.
    while (this._nextNote < this.notes.length) {
      const note = this.notes[this._nextNote];
      if (note.time > chartTime) break;
      this._nextNote++;
      note.judged = true;
      note.result = "perfect";
      note.visualHeld = note.sustain > 0 && note.endTime > chartTime;
      const lanes = note.open ? [0, 1, 2, 3, 4] : note.frets;
      for (const lane of lanes) this.renderer.flashLane?.(lane, note.time);
    }
  }
  stop() {
    this._haltLoop();
    this.paused = false;
    this.pausedSongTime = 0;
    this.playOffset = 0;
    this._rearmNotes(0);
  }
  _haltLoop() {
    this.running = false;
    this._clockOffset = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this._stopSource();
  }
  _emitProgress(force) {
    if (!this.onProgress) return;
    const t = this.songTime;
    if (force || Math.abs(t - this._lastProgressEmit) >= 0.05) {
      this._lastProgressEmit = t;
      this.onProgress(t, this.duration);
    }
  }
  _tick() {
    if (!this.running) return;
    this._updateClock();
    const t = this.songTime;
    try {
      this._advanceVisualNotes(this.chartTime);
      this.renderer.draw(this.chartTime);
      this._emitProgress(false);
    } catch (error) {
      if (!this._loopErrLogged) {
        this._loopErrLogged = true;
        console.error("[highway] visual render loop error (continuing):", error);
      }
    }
    if (this.duration && t >= this.duration) {
      this.pause();
      this.onEnded?.();
      return;
    }
    this.rafId = requestAnimationFrame(this._tick);
  }
  setMuted(on) { this.muted = Boolean(on); this._applyGain(); }
  dispose() {
    this.stop();
    this.gainNode?.disconnect();
    this.audioCtx?.close().catch(() => {});
  }
  setVolume(value) {
    const n = Number(value);
    this.volume = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
    this._applyGain();
  }
  _applyGain() { if (this.gainNode) this.gainNode.gain.value = this.muted ? 0 : this.volume; }
}
