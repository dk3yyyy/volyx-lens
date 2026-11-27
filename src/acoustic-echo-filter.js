'use strict';

const { createEnvelopeDoubleTalkDetector, DEFAULT_MARGIN_DB: DEFAULT_ENVELOPE_MARGIN_DB } = require('./echo-double-talk');

const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_DOWNSAMPLE_FACTOR = 8;
const DEFAULT_HISTORY_MS = 2000;
const DEFAULT_MAX_SEARCH_MS = 1500;
const DEFAULT_CORRELATION_THRESHOLD = 0.82;
const DEFAULT_MIN_RMS = 0.006;
const DEFAULT_FRAME_MS = 20;
const DEFAULT_LOCAL_FRAME_MARGIN_DB = 8;
const DEFAULT_LOCAL_RESIDUAL_SHARE = 0.4;
const DEFAULT_LOCAL_SHARE_THRESHOLD = 0.25;
const DEFAULT_DOUBLE_TALK_CORRELATION_THRESHOLD = 0.5;
// 'residual' is the waveform residual test. 'envelope' (experimental) uses the
// reverb-aware power detector in src/echo-double-talk.js once it has learned
// the echo path, and the residual test before that. Two synthetic room models
// rank them differently (scripts/eval-echo.js), so the default stays 'residual'
// until recorded speaker-mode sessions decide.
const DEFAULT_DOUBLE_TALK_MODE = 'residual';

function pcm16ToDownsampled(pcm, factor) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2) return new Float32Array(0);
  const sampleCount = Math.floor(pcm.length / 2);
  const outputCount = Math.floor(sampleCount / factor);
  const output = new Float32Array(outputCount);
  for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
    let sum = 0;
    const base = outputIndex * factor;
    for (let inner = 0; inner < factor; inner += 1) {
      sum += pcm.readInt16LE((base + inner) * 2) / 32768;
    }
    output[outputIndex] = sum / factor;
  }
  return output;
}

function centeredEnergy(samples) {
  if (!samples.length) return { mean: 0, energy: 0, rms: 0 };
  let sum = 0;
  let rawSquares = 0;
  for (const sample of samples) {
    sum += sample;
    rawSquares += sample * sample;
  }
  const mean = sum / samples.length;
  let energy = 0;
  for (const sample of samples) {
    const centered = sample - mean;
    energy += centered * centered;
  }
  return { mean, energy, rms: Math.sqrt(rawSquares / samples.length) };
}

function bestNormalizedCorrelation(reference, candidate, maxSearchSamples, step = 1) {
  if (!reference.length || candidate.length < 8 || reference.length < candidate.length) {
    return { correlation: 0, offset: -1, referenceRms: 0, candidateRms: 0 };
  }
  const candidateStats = centeredEnergy(candidate);
  if (candidateStats.energy <= Number.EPSILON) {
    return { correlation: 0, offset: -1, referenceRms: 0, candidateRms: candidateStats.rms };
  }
  const latestStart = reference.length - candidate.length;
  const earliestStart = Math.max(0, latestStart - Math.max(0, maxSearchSamples));
  let best = { correlation: 0, offset: -1, referenceRms: 0, candidateRms: candidateStats.rms };
  for (let start = latestStart; start >= earliestStart; start -= Math.max(1, step)) {
    let referenceSum = 0;
    let referenceSquares = 0;
    for (let index = 0; index < candidate.length; index += 1) {
      const value = reference[start + index];
      referenceSum += value;
      referenceSquares += value * value;
    }
    const referenceMean = referenceSum / candidate.length;
    let dot = 0;
    let referenceEnergy = 0;
    for (let index = 0; index < candidate.length; index += 1) {
      const ref = reference[start + index] - referenceMean;
      const mic = candidate[index] - candidateStats.mean;
      dot += ref * mic;
      referenceEnergy += ref * ref;
    }
    if (referenceEnergy <= Number.EPSILON) continue;
    const correlation = dot / Math.sqrt(referenceEnergy * candidateStats.energy);
    if (correlation > best.correlation) {
      best = {
        correlation,
        offset: start,
        referenceRms: Math.sqrt(referenceSquares / candidate.length),
        candidateRms: candidateStats.rms,
      };
    }
  }
  return best;
}

// Least-squares gain of the delayed reference segment against the mic chunk.
// A non-positive fit means the reference explains none of the microphone
// signal, so the prediction collapses to silence.
function fitEchoGain(reference, candidate, offset) {
  if (offset < 0 || !candidate.length || offset >= reference.length) return 0;
  const length = Math.min(candidate.length, reference.length - offset);
  if (length < 8) return 0;
  let referenceSum = 0;
  let candidateSum = 0;
  for (let index = 0; index < length; index += 1) {
    referenceSum += reference[offset + index];
    candidateSum += candidate[index];
  }
  const referenceMean = referenceSum / length;
  const candidateMean = candidateSum / length;
  let dot = 0;
  let referenceEnergy = 0;
  for (let index = 0; index < length; index += 1) {
    const ref = reference[offset + index] - referenceMean;
    dot += ref * (candidate[index] - candidateMean);
    referenceEnergy += ref * ref;
  }
  if (referenceEnergy <= Number.EPSILON) return 0;
  const gain = dot / referenceEnergy;
  return Number.isFinite(gain) && gain > 0 ? gain : 0;
}

// Split the aligned chunk into short frames and measure how much of each frame
// is *not* explained by the delayed, scaled reference. Frames whose mic energy
// sits clearly above the prediction (and above the room-noise floor) are local
// evidence: user speech during playback, i.e. double talk.
function measureLocalShare(reference, candidate, offset, gain, {
  frameSamples,
  localFrameMarginDb,
  localResidualShareThreshold,
  silenceFloorRms,
}) {
  const frameSize = Math.max(1, Math.floor(frameSamples));
  let frameCount = Math.floor(candidate.length / frameSize);
  if (frameCount < 1 && candidate.length > 0) frameCount = 1;
  if (frameCount < 1) return { localShare: 0, localFrames: 0, frameCount: 0, gain };
  const marginRatio = Math.pow(10, localFrameMarginDb / 10);
  let localFrames = 0;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * frameSize;
    const end = Math.min(candidate.length, start + frameSize);
    const length = end - start;
    if (length <= 0) continue;
    let micSum = 0;
    let refSum = 0;
    for (let index = 0; index < length; index += 1) {
      micSum += candidate[start + index];
      if (offset >= 0) refSum += reference[offset + start + index] || 0;
    }
    const micMean = micSum / length;
    const refMean = refSum / length;
    let micPower = 0;
    let predictionPower = 0;
    let residualPower = 0;
    for (let index = 0; index < length; index += 1) {
      const mic = candidate[start + index] - micMean;
      micPower += mic * mic;
      if (offset >= 0) {
        const predicted = gain * ((reference[offset + start + index] || 0) - refMean);
        predictionPower += predicted * predicted;
        const residual = mic - predicted;
        residualPower += residual * residual;
      } else {
        residualPower += mic * mic;
      }
    }
    micPower /= length;
    predictionPower /= length;
    residualPower /= length;
    const micFrameRms = Math.sqrt(micPower);
    if (micFrameRms < silenceFloorRms) continue;
    const residualShare = micPower > Number.EPSILON ? residualPower / micPower : 0;
    // A frame is local when it carries energy the echo path cannot explain:
    // either well above the scaled prediction (8 dB by default, for a local
    // talker louder than the playback), or when the unexplained residual
    // dominates the frame even at comparable loudness. The second test matters
    // for equal-loud double talk: uncorrelated addition only raises total
    // energy by ~3 dB, so an energy-only 8 dB rule would call that frame bleed
    // while the residual is already half of the mic signal.
    if (micPower > predictionPower * marginRatio || residualShare >= localResidualShareThreshold) {
      localFrames += 1;
    }
  }
  return { localShare: localFrames / frameCount, localFrames, frameCount, gain };
}

function clampCorrelation(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

class AcousticEchoFilter {
  constructor({
    sampleRate = DEFAULT_SAMPLE_RATE,
    downsampleFactor = DEFAULT_DOWNSAMPLE_FACTOR,
    historyMs = DEFAULT_HISTORY_MS,
    maxSearchMs = DEFAULT_MAX_SEARCH_MS,
    correlationThreshold = DEFAULT_CORRELATION_THRESHOLD,
    minRms = DEFAULT_MIN_RMS,
    frameMs = DEFAULT_FRAME_MS,
    localFrameMarginDb = DEFAULT_LOCAL_FRAME_MARGIN_DB,
    localResidualShareThreshold = DEFAULT_LOCAL_RESIDUAL_SHARE,
    localShareThreshold = DEFAULT_LOCAL_SHARE_THRESHOLD,
    silenceFloorRms = minRms,
    doubleTalkCorrelationThreshold = DEFAULT_DOUBLE_TALK_CORRELATION_THRESHOLD,
    doubleTalkMode = DEFAULT_DOUBLE_TALK_MODE,
    envelopeMarginDb = DEFAULT_ENVELOPE_MARGIN_DB,
  } = {}) {
    this.sampleRate = sampleRate;
    this.downsampleFactor = downsampleFactor;
    this.downsampledRate = sampleRate / downsampleFactor;
    this.maxHistorySamples = Math.ceil(this.downsampledRate * historyMs / 1000);
    this.maxSearchSamples = Math.ceil(this.downsampledRate * maxSearchMs / 1000);
    this.correlationThreshold = correlationThreshold;
    this.minRms = minRms;
    this.frameSamples = Math.max(1, Math.round(this.downsampledRate * frameMs / 1000));
    this.localFrameMarginDb = localFrameMarginDb;
    this.localResidualShareThreshold = localResidualShareThreshold;
    this.localShareThreshold = localShareThreshold;
    this.silenceFloorRms = silenceFloorRms;
    this.doubleTalkCorrelationThreshold = doubleTalkCorrelationThreshold;
    this.doubleTalkMode = doubleTalkMode === 'envelope' ? 'envelope' : 'residual';
    this.envelope = createEnvelopeDoubleTalkDetector({
      frameSamples: this.frameSamples,
      floorRms: silenceFloorRms,
      learnCorrelation: correlationThreshold,
      marginDb: envelopeMarginDb,
    });
    this.reference = new Float32Array(0);
  }

  reset() {
    this.reference = new Float32Array(0);
    this.envelope.reset();
  }

  observeSystem(pcm) {
    const incoming = pcm16ToDownsampled(pcm, this.downsampleFactor);
    if (!incoming.length) return;
    const keep = Math.min(this.reference.length, Math.max(0, this.maxHistorySamples - incoming.length));
    const nextLength = Math.min(this.maxHistorySamples, keep + incoming.length);
    const next = new Float32Array(nextLength);
    if (keep) next.set(this.reference.subarray(this.reference.length - keep), 0);
    next.set(incoming.subarray(Math.max(0, incoming.length - (nextLength - keep))), keep);
    this.reference = next;
  }

  inspectMicrophone(pcm) {
    const candidate = pcm16ToDownsampled(pcm, this.downsampleFactor);
    const match = bestNormalizedCorrelation(this.reference, candidate, this.maxSearchSamples, 2);
    const correlation = clampCorrelation(match.correlation);
    const active = candidate.length >= 32
      && match.candidateRms >= this.minRms
      && match.referenceRms >= this.minRms
      && match.offset >= 0;
    const gain = active ? fitEchoGain(this.reference, candidate, match.offset) : 0;
    const residual = measureLocalShare(
      this.reference,
      candidate,
      match.offset,
      gain,
      {
        frameSamples: this.frameSamples,
        localFrameMarginDb: this.localFrameMarginDb,
        localResidualShareThreshold: this.localResidualShareThreshold,
        silenceFloorRms: this.silenceFloorRms,
      },
    );
    const envelope = active && this.doubleTalkMode === 'envelope'
      ? this.envelope.inspect(this.reference, candidate, match.offset, correlation)
      : null;
    const detector = envelope && envelope.learned ? 'envelope' : 'residual';
    const { localShare, localFrames, frameCount } = detector === 'envelope' ? envelope : residual;

    let label = 'local';
    if (active && correlation >= this.doubleTalkCorrelationThreshold
        && localShare >= this.localShareThreshold) {
      // The playback is present in the mic (correlation is well above chance)
      // but a meaningful share of frames carries energy the reference cannot
      // explain: the user is talking over the remote. Transcribe it.
      label = 'double-talk';
    } else if (active && correlation >= this.correlationThreshold
        && localShare < this.localShareThreshold) {
      label = 'bleed';
    }

    return {
      suppress: label === 'bleed',
      label,
      localShare,
      correlation,
      candidateRms: match.candidateRms,
      referenceRms: match.referenceRms,
      localFrames,
      frameCount,
      gain,
      detector,
      echoPathGain: envelope ? envelope.pathGain : null,
    };
  }
}

function createAcousticEchoFilter(options) {
  return new AcousticEchoFilter(options);
}

module.exports = {
  DEFAULT_SAMPLE_RATE,
  DEFAULT_DOWNSAMPLE_FACTOR,
  DEFAULT_HISTORY_MS,
  DEFAULT_MAX_SEARCH_MS,
  DEFAULT_CORRELATION_THRESHOLD,
  DEFAULT_MIN_RMS,
  DEFAULT_FRAME_MS,
  DEFAULT_LOCAL_FRAME_MARGIN_DB,
  DEFAULT_LOCAL_RESIDUAL_SHARE,
  DEFAULT_LOCAL_SHARE_THRESHOLD,
  DEFAULT_DOUBLE_TALK_CORRELATION_THRESHOLD,
  DEFAULT_DOUBLE_TALK_MODE,
  pcm16ToDownsampled,
  bestNormalizedCorrelation,
  fitEchoGain,
  measureLocalShare,
  AcousticEchoFilter,
  createAcousticEchoFilter,
};
