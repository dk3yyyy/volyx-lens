'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAcousticEchoFilter,
  pcm16ToDownsampled,
  bestNormalizedCorrelation,
} = require('../src/acoustic-echo-filter');

const SAMPLE_RATE = 24000;

function clamp(value) {
  return Math.max(-1, Math.min(1, value));
}

function makeSignal(sampleCount, variant = 0) {
  const samples = new Float64Array(sampleCount);
  let noiseState = 0x12345678 + variant * 101;
  let smoothedNoise = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    noiseState = (1664525 * noiseState + 1013904223) >>> 0;
    const noise = (noiseState / 0xffffffff) * 2 - 1;
    smoothedNoise = smoothedNoise * 0.94 + noise * 0.06;
    const time = index / SAMPLE_RATE;
    const voiced = Math.sin(2 * Math.PI * (137 + variant * 31) * time)
      + 0.55 * Math.sin(2 * Math.PI * (271 + variant * 47) * time + 0.3);
    const envelope = 0.35 + 0.65 * Math.pow(Math.sin(2 * Math.PI * 2.7 * time), 2);
    samples[index] = clamp((voiced * 0.22 + smoothedNoise * 0.45) * envelope);
  }
  return samples;
}

function toPcm(samples, gain = 1) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = clamp(samples[index] * gain);
    pcm.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), index * 2);
  }
  return pcm;
}

function mix(left, right, leftGain = 1, rightGain = 1) {
  const length = Math.min(left.length, right.length);
  const output = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    output[index] = clamp(left[index] * leftGain + right[index] * rightGain);
  }
  return output;
}

function makeTone(sampleCount, frequency = 1000, amplitude = 1) {
  const samples = new Float64Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = Math.sin(2 * Math.PI * frequency * index / SAMPLE_RATE) * amplitude;
  }
  return samples;
}

function rms(samples, gain = 1) {
  let sum = 0;
  for (const sample of samples) sum += (sample * gain) ** 2;
  return Math.sqrt(sum / samples.length);
}

function makeQuietNoise(sampleCount, amplitude = 0.0008) {
  const samples = new Float64Array(sampleCount);
  let state = 0x9e3779b9;
  for (let index = 0; index < sampleCount; index += 1) {
    state = (1664525 * state + 1013904223) >>> 0;
    samples[index] = ((state / 0xffffffff) * 2 - 1) * amplitude;
  }
  return samples;
}

test('normalized correlation finds delayed attenuated speaker echo', () => {
  const source = makeSignal(SAMPLE_RATE * 2);
  const echo = source.slice(30000, 32048);
  const reference = pcm16ToDownsampled(toPcm(source), 8);
  const candidate = pcm16ToDownsampled(toPcm(echo, 0.28), 8);
  const match = bestNormalizedCorrelation(reference, candidate, 4500, 2);
  assert.ok(match.correlation > 0.98, `correlation=${match.correlation}`);
});

test('filter suppresses echo-only mic chunks but preserves independent real speech', () => {
  const source = makeSignal(SAMPLE_RATE * 2);
  const filter = createAcousticEchoFilter();
  filter.observeSystem(toPcm(source));

  const echoOnly = source.slice(30000, 32048);
  const echoResult = filter.inspectMicrophone(toPcm(echoOnly, 0.3));
  assert.equal(echoResult.suppress, true);
  assert.ok(echoResult.correlation >= 0.82);

  const realSpeech = makeSignal(2048, 7);
  const speechResult = filter.inspectMicrophone(toPcm(realSpeech, 0.45));
  assert.equal(speechResult.suppress, false);
  assert.ok(speechResult.correlation < 0.82);
});

test('real user speech mixed over speaker playback is retained', () => {
  const source = makeSignal(SAMPLE_RATE * 2);
  const filter = createAcousticEchoFilter();
  filter.observeSystem(toPcm(source));

  const echo = source.slice(30000, 32048);
  const realSpeech = makeSignal(2048, 11);
  const microphone = mix(echo, realSpeech, 0.22, 0.5);
  const result = filter.inspectMicrophone(toPcm(microphone));
  assert.equal(result.suppress, false, `correlation=${result.correlation}`);
});

test('filter ignores silence and reset removes stale system reference', () => {
  const source = makeSignal(SAMPLE_RATE * 2);
  const filter = createAcousticEchoFilter();
  filter.observeSystem(toPcm(source));
  assert.equal(filter.inspectMicrophone(Buffer.alloc(4096)).suppress, false);
  filter.reset();
  const echo = source.slice(30000, 32048);
  const result = filter.inspectMicrophone(toPcm(echo, 0.3));
  assert.equal(result.suppress, false);
  assert.equal(result.correlation, 0);
});

test('pure delayed scaled bleed is labelled bleed and suppressed', () => {
  const source = makeSignal(SAMPLE_RATE * 2);
  const filter = createAcousticEchoFilter();
  filter.observeSystem(toPcm(source));

  const echo = source.slice(30000, 30000 + 2048);
  const result = filter.inspectMicrophone(toPcm(echo, 0.3));

  assert.equal(result.label, 'bleed');
  assert.equal(result.suppress, true);
  assert.equal(result.localShare, 0);
  assert.ok(result.correlation >= 0.82, `correlation=${result.correlation}`);
});

test('equal-loud independent tone over the echo is double-talk, not bleed', () => {
  const source = makeSignal(SAMPLE_RATE * 2);
  const filter = createAcousticEchoFilter();
  filter.observeSystem(toPcm(source));

  const echo = source.slice(30000, 30000 + 2048);
  const echoOnly = filter.inspectMicrophone(toPcm(echo, 0.3));

  // The local talker's tone has the same RMS as the leaked playback in the mic.
  const tone = makeTone(2048, 1000, rms(echo, 0.3) * Math.SQRT2);
  const microphone = mix(echo, tone, 0.3, 1);
  const result = filter.inspectMicrophone(toPcm(microphone));

  assert.equal(result.label, 'double-talk');
  assert.equal(result.suppress, false);
  assert.ok(result.correlation > 0.5, `correlation=${result.correlation}`);
  assert.ok(result.localShare >= 0.5, `localShare=${result.localShare}`);
  assert.ok(result.localShare > echoOnly.localShare,
    `double-talk localShare=${result.localShare} must exceed bleed localShare=${echoOnly.localShare}`);
});

test('microphone speech while the system is silent is local', () => {
  const filter = createAcousticEchoFilter();
  filter.observeSystem(Buffer.alloc(SAMPLE_RATE)); // one second of silence

  const result = filter.inspectMicrophone(toPcm(makeSignal(2048, 3), 0.35));
  assert.equal(result.label, 'local');
  assert.equal(result.suppress, false);
  assert.equal(result.correlation, 0);
});

test('quiet room noise stays local and is never suppressed', () => {
  const source = makeSignal(SAMPLE_RATE * 2);
  const filter = createAcousticEchoFilter();
  filter.observeSystem(toPcm(source));

  const result = filter.inspectMicrophone(toPcm(makeQuietNoise(2048)));
  assert.equal(result.label, 'local');
  assert.equal(result.suppress, false);
});

test('a loud mic-only burst over uncorrelated playback is local', () => {
  const playback = makeSignal(SAMPLE_RATE * 2, 5);
  const filter = createAcousticEchoFilter();
  filter.observeSystem(toPcm(playback));

  const burst = new Float64Array(2048);
  for (let index = 0; index < burst.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const active = index > 682 && index < 1365;
    burst[index] = active
      ? 0.55 * Math.sin(2 * Math.PI * 440 * time) + 0.22 * Math.sin(2 * Math.PI * 900 * time)
      : 0;
  }
  const result = filter.inspectMicrophone(toPcm(burst));
  assert.equal(result.label, 'local');
  assert.equal(result.suppress, false);
  assert.ok(result.correlation < 0.82, `correlation=${result.correlation}`);
});
