'use strict';

// Is the call audio actually reaching the microphone?
//
// The text-level cross-talk dedupe deletes a You turn that repeats a nearby
// Them turn. That is right when speaker echo leaks into the mic and wrong when
// it does not: with headphones, a You turn that repeats the question ("the
// deadline for the first milestone is Friday") is the user's real answer.
//
// This tracks evidence of acoustic coupling from the echo filter and answers
// one question for the transcript layer: may cross-talk dedupe remove You text
// right now?
//
// Only `bleed` labels count as evidence. `double-talk` is not used: its 0.5
// correlation floor is reachable by chance (best-of-many-lags correlation on a
// short chunk), so it also fires with headphones.

const SPEAKER_MODES = Object.freeze(['auto', 'speakers', 'headphones']);
const DEFAULT_WINDOW_MS = 60000;
const DEFAULT_MIN_BLEED_CHUNKS = 3;
const MAX_TRACKED = 512;

function normalizeSpeakerMode(value) {
  return SPEAKER_MODES.includes(value) ? value : 'auto';
}

class AcousticCoupling {
  constructor({
    windowMs = DEFAULT_WINDOW_MS,
    minBleedChunks = DEFAULT_MIN_BLEED_CHUNKS,
    mode = 'auto',
    now = () => Date.now(),
  } = {}) {
    this.windowMs = Math.max(1000, Number(windowMs) || DEFAULT_WINDOW_MS);
    this.minBleedChunks = Math.max(1, Math.floor(Number(minBleedChunks) || DEFAULT_MIN_BLEED_CHUNKS));
    this.mode = normalizeSpeakerMode(mode);
    this.now = now;
    this.bleedAt = [];
  }

  setMode(mode) {
    this.mode = normalizeSpeakerMode(mode);
  }

  reset() {
    this.bleedAt = [];
  }

  observe(label, at = this.now()) {
    if (label !== 'bleed' || !Number.isFinite(at)) return;
    this.bleedAt.push(at);
    if (this.bleedAt.length > MAX_TRACKED) this.bleedAt.splice(0, this.bleedAt.length - MAX_TRACKED);
  }

  _recentBleed(at) {
    const since = at - this.windowMs;
    while (this.bleedAt.length && this.bleedAt[0] < since) this.bleedAt.shift();
    return this.bleedAt.length;
  }

  // True when cross-talk dedupe may remove You text.
  active(at = this.now()) {
    if (this.mode === 'speakers') return true;
    if (this.mode === 'headphones') return false;
    return this._recentBleed(at) >= this.minBleedChunks;
  }

  status(at = this.now()) {
    return {
      mode: this.mode,
      recentBleedChunks: this._recentBleed(at),
      active: this.active(at),
    };
  }
}

function createAcousticCoupling(options) {
  return new AcousticCoupling(options);
}

module.exports = {
  SPEAKER_MODES,
  DEFAULT_WINDOW_MS,
  DEFAULT_MIN_BLEED_CHUNKS,
  normalizeSpeakerMode,
  AcousticCoupling,
  createAcousticCoupling,
};
