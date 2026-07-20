'use strict';

const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_DOWNSAMPLE_FACTOR = 8;
const DEFAULT_HISTORY_MS = 2000;
const DEFAULT_MAX_SEARCH_MS = 1500;
const DEFAULT_CORRELATION_THRESHOLD = 0.82;
const DEFAULT_MIN_RMS = 0.006;

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

class AcousticEchoFilter {
  constructor({
    sampleRate = DEFAULT_SAMPLE_RATE,
    downsampleFactor = DEFAULT_DOWNSAMPLE_FACTOR,
    historyMs = DEFAULT_HISTORY_MS,
    maxSearchMs = DEFAULT_MAX_SEARCH_MS,
    correlationThreshold = DEFAULT_CORRELATION_THRESHOLD,
    minRms = DEFAULT_MIN_RMS,
  } = {}) {
    this.sampleRate = sampleRate;
    this.downsampleFactor = downsampleFactor;
    this.downsampledRate = sampleRate / downsampleFactor;
    this.maxHistorySamples = Math.ceil(this.downsampledRate * historyMs / 1000);
    this.maxSearchSamples = Math.ceil(this.downsampledRate * maxSearchMs / 1000);
    this.correlationThreshold = correlationThreshold;
    this.minRms = minRms;
    this.reference = new Float32Array(0);
  }

  reset() {
    this.reference = new Float32Array(0);
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
    const echoDominant = candidate.length >= 32
      && match.candidateRms >= this.minRms
      && match.referenceRms >= this.minRms
      && match.correlation >= this.correlationThreshold;
    return {
      suppress: echoDominant,
      correlation: Math.max(0, Math.min(1, match.correlation || 0)),
      candidateRms: match.candidateRms,
      referenceRms: match.referenceRms,
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
  pcm16ToDownsampled,
  bestNormalizedCorrelation,
  AcousticEchoFilter,
  createAcousticEchoFilter,
};
