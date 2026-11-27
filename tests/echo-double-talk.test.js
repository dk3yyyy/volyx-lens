'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAcousticEchoFilter } = require('../src/acoustic-echo-filter');
const {
  framePowers,
  createEnvelopeDoubleTalkDetector,
  DEFAULT_MIN_LEARN_UPDATES,
} = require('../src/echo-double-talk');

const SAMPLE_RATE = 24000;
const CHUNK = 2048;

function clamp(value) {
  return Math.max(-1, Math.min(1, value));
}

// Speech-like signal: noise through a resonant filter with a syllabic envelope.
function makeSpeech(sampleCount, variant = 0) {
  const samples = new Float64Array(sampleCount);
  let state = 0x2545f491 + variant * 7919;
  let y1 = 0;
  let y2 = 0;
  const rate = 3.7 + variant * 0.6;
  for (let index = 0; index < sampleCount; index += 1) {
    state = (1664525 * state + 1013904223) >>> 0;
    const noise = (state / 0xffffffff) * 2 - 1;
    const y = noise + 1.6 * y1 - 0.8 * y2;
    y2 = y1;
    y1 = y;
    const time = index / SAMPLE_RATE;
    const envelope = Math.pow(Math.max(0, Math.sin(2 * Math.PI * rate * time + variant)), 1.5);
    samples[index] = y * envelope;
  }
  return normalize(samples, 0.1);
}

function rms(samples, start = 0, end = samples.length) {
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / Math.max(1, end - start));
}

function normalize(samples, targetRms) {
  const scale = targetRms / (rms(samples) || 1);
  return samples.map((value) => value * scale);
}

// Delay, attenuate and (optionally) add a few decaying reflections.
function speakerEcho(source, { delayMs = 60, gain = 0.25, reflections = [] } = {}) {
  const output = new Float64Array(source.length);
  const taps = [[Math.round(SAMPLE_RATE * delayMs / 1000), gain]];
  for (const [extraMs, tapGain] of reflections) taps.push([Math.round(SAMPLE_RATE * (delayMs + extraMs) / 1000), gain * tapGain]);
  for (const [delay, tapGain] of taps) {
    for (let index = delay; index < source.length; index += 1) output[index] += source[index - delay] * tapGain;
  }
  return output;
}

function toPcm(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = clamp(samples[index]);
    pcm.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), index * 2);
  }
  return pcm;
}

// Feeds system audio 250 ms ahead of each mic chunk, as MicEchoCoordinator does,
// and returns every inspection result with the chunk's start sample.
function runFilter(filter, system, microphone) {
  const lead = Math.round(SAMPLE_RATE * 0.25);
  let fed = 0;
  const results = [];
  for (let start = 0; start + CHUNK <= microphone.length; start += CHUNK) {
    const referenceEnd = Math.min(system.length, start + CHUNK + lead);
    while (fed < referenceEnd) {
      const next = Math.min(referenceEnd, fed + CHUNK);
      filter.observeSystem(toPcm(system.subarray(fed, next)));
      fed = next;
    }
    results.push({ start, ...filter.inspectMicrophone(toPcm(microphone.subarray(start, start + CHUNK))) });
  }
  return results;
}

function add(...signals) {
  const output = new Float64Array(signals[0].length);
  for (const signal of signals) for (let index = 0; index < output.length; index += 1) output[index] += signal[index];
  return output;
}

function scale(signal, factor) {
  return signal.map((value) => value * factor);
}

test('framePowers measures centred power per frame', () => {
  const samples = new Float32Array([1, -1, 1, -1, 0, 0, 0, 0]);
  const powers = framePowers(samples, 0, 2, 4);
  assert.equal(powers[0], 1);
  assert.equal(powers[1], 0);
});

test('envelope detector is untrusted until it has learned from several echo chunks', () => {
  const detector = createEnvelopeDoubleTalkDetector({ frameSamples: 60, floorRms: 0.001, learnCorrelation: 0.82 });
  const reference = new Float32Array(3000).map((_, index) => Math.sin(index / 3) * 0.1);
  const candidate = reference.slice(2000, 2256).map((value) => value * 0.3);
  for (let update = 1; update < DEFAULT_MIN_LEARN_UPDATES; update += 1) {
    assert.equal(detector.inspect(reference, candidate, 2000, 0.99).learned, false);
  }
  assert.equal(detector.inspect(reference, candidate, 2000, 0.99).learned, true);
  detector.reset();
  assert.equal(detector.inspect(reference, candidate, 2000, 0.5).learned, false);
});

test('a talker quieter than the speaker echo is kept once the echo path is learned', () => {
  const remote = makeSpeech(SAMPLE_RATE * 8, 0);
  const echo = speakerEcho(remote);
  const local = normalize(makeSpeech(SAMPLE_RATE * 8, 1), rms(echo) * 0.6);
  // Four seconds of echo only, then the user talks over it at about -4.4 dB.
  const half = SAMPLE_RATE * 4;
  const userTrack = new Float64Array(local.length);
  userTrack.set(local.subarray(half), half);
  const results = runFilter(createAcousticEchoFilter({ doubleTalkMode: 'envelope' }), remote, add(echo, userTrack));

  const talking = results.filter((result) => result.start >= half && rms(userTrack, result.start, result.start + CHUNK) >= 0.5 * rms(echo, result.start, result.start + CHUNK) && rms(userTrack, result.start, result.start + CHUNK) > 0.006);
  assert.ok(talking.length >= 10, `talking chunks=${talking.length}`);
  const dropped = talking.filter((result) => result.suppress).length;
  const legacy = runFilter(createAcousticEchoFilter({ doubleTalkMode: 'residual', localResidualShareThreshold: 2, localFrameMarginDb: 99 }), remote, add(echo, userTrack))
    .filter((result) => talking.some((chunk) => chunk.start === result.start) && result.suppress).length;
  assert.ok(dropped < legacy, `envelope dropped ${dropped}, correlation-only dropped ${legacy}`);
  assert.ok(dropped / talking.length <= 0.25, `dropped ${dropped}/${talking.length} of the user's chunks`);
  assert.ok(results.some((result) => result.detector === 'envelope'), 'envelope detector never took over');
});

test('default mode is the waveform residual test', () => {
  assert.equal(createAcousticEchoFilter().doubleTalkMode, 'residual');
  assert.equal(createAcousticEchoFilter({ doubleTalkMode: 'envelope' }).doubleTalkMode, 'envelope');
});

test('reverberant echo with no talker gets fewer false double-talk labels in envelope mode', () => {
  const remote = makeSpeech(SAMPLE_RATE * 8, 0);
  const echo = speakerEcho(remote, { reflections: [[12, 0.6], [31, 0.45], [57, 0.3], [94, 0.2], [140, 0.12]] });
  const residualOnly = runFilter(createAcousticEchoFilter({ doubleTalkMode: 'residual' }), remote, echo);
  const envelope = runFilter(createAcousticEchoFilter({ doubleTalkMode: 'envelope' }), remote, echo);
  const count = (results, label) => results.filter((result) => result.label === label).length;
  assert.ok(count(envelope, 'double-talk') < count(residualOnly, 'double-talk'),
    `double-talk labels: envelope ${count(envelope, 'double-talk')}, residual ${count(residualOnly, 'double-talk')}`);
  assert.ok(count(envelope, 'bleed') >= count(residualOnly, 'bleed'),
    `bleed labels: envelope ${count(envelope, 'bleed')}, residual ${count(residualOnly, 'bleed')}`);
});

test('reset forgets the learned echo path', () => {
  const remote = makeSpeech(SAMPLE_RATE * 3, 0);
  const filter = createAcousticEchoFilter({ doubleTalkMode: 'envelope' });
  runFilter(filter, remote, speakerEcho(remote));
  assert.ok(filter.envelope.trusted);
  filter.reset();
  assert.equal(filter.envelope.trusted, false);
  assert.equal(filter.envelope.pathGain, null);
});
