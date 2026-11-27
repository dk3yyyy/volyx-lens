'use strict';

// Envelope double-talk detector for the acoustic echo filter.
//
// The waveform residual test (measureLocalShare) fits one delay and one gain.
// Real rooms add a reverb tail that a single tap cannot explain, so pure echo
// leaves a large per-frame residual and gets labelled double-talk. That keeps
// echo the filter should have removed.
//
// This detector works on frame power instead of waveform:
//   1. The delayed reference is smeared over a decaying tail, so reverberant
//      echo is still "explained" by the playback that caused it.
//   2. The echo-path power gain is learned across chunks from confident echo
//      (correlation above the bleed threshold), using a LOW quantile of the
//      per-frame mic/prediction ratio. Local speech only ever adds energy, so
//      the low quantile tracks the echo path even when the user is talking.
//   3. A frame is local when its power exceeds the learned prediction by a
//      margin. No margin is chosen per room; the gain carries the room.
//
// Until a gain has been learned, `inspect` reports `learned: false` and the
// caller falls back to the waveform residual test.

const DEFAULT_TAIL_FRAMES = 12;        // 240 ms of reverb tail at 20 ms frames
const DEFAULT_DECAY_PER_FRAME = 0.55;  // about -2.6 dB per 20 ms frame
const DEFAULT_MARGIN_DB = 1.5;
const DEFAULT_LEARN_RATE = 0.15;
const DEFAULT_LEARN_QUANTILE = 0.5;
// The gain is trusted only after this many confident echo chunks, so one
// unusual chunk cannot set the decision threshold.
const DEFAULT_MIN_LEARN_UPDATES = 3;

function framePowers(samples, start, count, frameSize) {
  const out = new Float32Array(count);
  for (let frame = 0; frame < count; frame += 1) {
    const base = start + frame * frameSize;
    let sum = 0;
    let n = 0;
    for (let index = 0; index < frameSize; index += 1) {
      const position = base + index;
      if (position < 0 || position >= samples.length) continue;
      sum += samples[position];
      n += 1;
    }
    if (!n) continue;
    const mean = sum / n;
    let power = 0;
    for (let index = 0; index < frameSize; index += 1) {
      const position = base + index;
      if (position < 0 || position >= samples.length) continue;
      const centered = samples[position] - mean;
      power += centered * centered;
    }
    out[frame] = power / n;
  }
  return out;
}

class EnvelopeDoubleTalkDetector {
  constructor({
    frameSamples,
    floorRms,
    learnCorrelation,
    tailFrames = DEFAULT_TAIL_FRAMES,
    decayPerFrame = DEFAULT_DECAY_PER_FRAME,
    marginDb = DEFAULT_MARGIN_DB,
    learnRate = DEFAULT_LEARN_RATE,
    learnQuantile = DEFAULT_LEARN_QUANTILE,
    minLearnUpdates = DEFAULT_MIN_LEARN_UPDATES,
  } = {}) {
    if (!Number.isFinite(frameSamples) || frameSamples < 1) throw new TypeError('frameSamples is required.');
    this.frameSamples = Math.floor(frameSamples);
    this.floorPower = Math.max(0, Number(floorRms) || 0) ** 2;
    this.learnCorrelation = Number(learnCorrelation);
    this.tailFrames = Math.max(0, Math.floor(tailFrames));
    this.decayPerFrame = Math.max(0, Math.min(1, decayPerFrame));
    this.margin = Math.pow(10, marginDb / 10);
    this.learnRate = Math.max(0, Math.min(1, learnRate));
    this.learnQuantile = Math.max(0, Math.min(1, learnQuantile));
    this.minLearnUpdates = Math.max(1, Math.floor(minLearnUpdates));
    this.pathGain = null;
    this.updates = 0;
  }

  get trusted() {
    return this.pathGain !== null && this.updates >= this.minLearnUpdates;
  }

  reset() {
    this.pathGain = null;
    this.updates = 0;
  }

  // Predicted echo power per mic frame: the strongest recent reference frame,
  // decayed by how long ago it played.
  predict(reference, offset, count) {
    const frameSize = this.frameSamples;
    const history = framePowers(reference, offset - this.tailFrames * frameSize, count + this.tailFrames, frameSize);
    const prediction = new Float32Array(count);
    for (let frame = 0; frame < count; frame += 1) {
      let best = 0;
      let weight = 1;
      for (let back = 0; back <= this.tailFrames; back += 1) {
        const value = history[frame + this.tailFrames - back] * weight;
        if (value > best) best = value;
        weight *= this.decayPerFrame;
      }
      prediction[frame] = best;
    }
    return prediction;
  }

  _learn(micPowers, prediction) {
    const ratios = [];
    for (let frame = 0; frame < micPowers.length; frame += 1) {
      if (prediction[frame] > this.floorPower && micPowers[frame] > this.floorPower) {
        ratios.push(micPowers[frame] / prediction[frame]);
      }
    }
    if (!ratios.length) return;
    ratios.sort((left, right) => left - right);
    const low = ratios[Math.floor((ratios.length - 1) * this.learnQuantile)];
    if (!Number.isFinite(low) || low <= 0) return;
    this.pathGain = this.pathGain === null ? low : this.pathGain + this.learnRate * (low - this.pathGain);
    this.updates += 1;
  }

  inspect(reference, candidate, offset, correlation) {
    const frameCount = Math.max(1, Math.floor(candidate.length / this.frameSamples));
    if (offset < 0 || !candidate.length) {
      return { learned: this.trusted, localShare: 0, localFrames: 0, frameCount, pathGain: this.pathGain };
    }
    const micPowers = framePowers(candidate, 0, frameCount, this.frameSamples);
    const prediction = this.predict(reference, offset, frameCount);
    if (Number.isFinite(this.learnCorrelation) && correlation >= this.learnCorrelation) {
      this._learn(micPowers, prediction);
    }
    if (!this.trusted) {
      return { learned: false, localShare: 0, localFrames: 0, frameCount, pathGain: this.pathGain };
    }
    let localFrames = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (micPowers[frame] < this.floorPower) continue;
      if (micPowers[frame] > this.margin * this.pathGain * prediction[frame]) localFrames += 1;
    }
    return { learned: true, localShare: localFrames / frameCount, localFrames, frameCount, pathGain: this.pathGain };
  }
}

function createEnvelopeDoubleTalkDetector(options) {
  return new EnvelopeDoubleTalkDetector(options);
}

module.exports = {
  DEFAULT_TAIL_FRAMES,
  DEFAULT_DECAY_PER_FRAME,
  DEFAULT_MARGIN_DB,
  DEFAULT_LEARN_RATE,
  DEFAULT_LEARN_QUANTILE,
  DEFAULT_MIN_LEARN_UPDATES,
  framePowers,
  EnvelopeDoubleTalkDetector,
  createEnvelopeDoubleTalkDetector,
};
