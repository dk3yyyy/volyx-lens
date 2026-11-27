'use strict';

// What to send downstream when the echo filter suppresses a mic chunk.
//
// Dropping the chunk splices the audio on either side together. Between
// utterances that is harmless and saves cloud seconds. Inside the user's own
// speech (a bleed chunk between two syllables while they talk over the remote)
// it joins the syllables, shifts later timestamps, and hides the pause the VAD
// needs to close a window. So:
//
//   - a suppressed chunk within `hangoverMs` of the last routed voiced mic
//     chunk is replaced with digital silence of the same length;
//   - any other suppressed chunk is dropped, as before.
//
// `holdMs` caps how long one run of silence fill can last, so a long echo
// passage after the user stops does not stream silence indefinitely.

const DEFAULT_HANGOVER_MS = 300;
const DEFAULT_HOLD_MS = 1200;
const DEFAULT_VOICED_RMS = 0.006 * 32768;

function pcmRms(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2) return 0;
  const samples = Math.floor(pcm.length / 2);
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = pcm.readInt16LE(index * 2);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

class EchoGapFill {
  constructor({
    hangoverMs = DEFAULT_HANGOVER_MS,
    holdMs = DEFAULT_HOLD_MS,
    voicedRms = DEFAULT_VOICED_RMS,
    sampleRate = 24000,
    now = () => Date.now(),
  } = {}) {
    this.hangoverMs = Math.max(0, Number(hangoverMs) || 0);
    this.holdMs = Math.max(0, Number(holdMs) || 0);
    this.voicedRms = Math.max(0, Number(voicedRms) || 0);
    this.maxFillBytes = Math.max(0, Math.round((Number(sampleRate) || 24000) * 2 * this.holdMs / 1000));
    this.now = now;
    this.reset();
  }

  reset() {
    this.lastVoicedAt = null;
    this.fillBytes = 0;
  }

  // Call for every mic chunk that is routed normally.
  routed(pcm, at = this.now()) {
    this.fillBytes = 0;
    if (pcmRms(pcm) >= this.voicedRms) this.lastVoicedAt = at;
  }

  // Call for every suppressed chunk. Returns a silent buffer to route, or null
  // to drop the chunk.
  suppressed(pcm, at = this.now()) {
    if (!Buffer.isBuffer(pcm) || !pcm.length || this.lastVoicedAt === null) return null;
    // Hangover decides whether a run may start. Once it has started, let the
    // byte budget decide when it ends, so a 300 ms hangover can still supply
    // the 700 ms pause the local VAD needs to close a turn.
    if (this.fillBytes <= 0 && at - this.lastVoicedAt > this.hangoverMs) return null;
    // The cap is audio duration, not elapsed clock time: queued chunks can be
    // drained back-to-back with the same timestamp and must not exceed holdMs.
    const remaining = this.maxFillBytes - this.fillBytes;
    if (remaining <= 0) return null;
    const length = Math.min(pcm.length, remaining - (remaining % 2));
    if (length <= 0) return null;
    this.fillBytes += length;
    return Buffer.alloc(length);
  }
}

function createEchoGapFill(options) {
  return new EchoGapFill(options);
}

module.exports = {
  DEFAULT_HANGOVER_MS,
  DEFAULT_HOLD_MS,
  DEFAULT_VOICED_RMS,
  pcmRms,
  EchoGapFill,
  createEchoGapFill,
};
