'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAcousticEchoFilter } = require('../src/acoustic-echo-filter');
const { createMicEchoCoordinator } = require('../src/mic-echo-coordinator');

const SAMPLE_RATE = 24000;

function makeSignal(sampleCount) {
  const pcm = Buffer.alloc(sampleCount * 2);
  let state = 0x12345678;
  let smooth = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    state = (1664525 * state + 1013904223) >>> 0;
    smooth = smooth * 0.92 + (((state / 0xffffffff) * 2 - 1) * 0.08);
    const voiced = Math.sin(2 * Math.PI * 173 * index / SAMPLE_RATE) * 0.18;
    const value = Math.max(-1, Math.min(1, smooth * 0.55 + voiced));
    pcm.writeInt16LE(Math.round(value * 0x7fff), index * 2);
  }
  return pcm;
}

function scaledSlice(pcm, startSample, sampleCount, gain) {
  const output = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    output.writeInt16LE(Math.round(pcm.readInt16LE((startSample + index) * 2) * gain), index * 2);
  }
  return output;
}

test('mic arriving before its system reference waits and is suppressed after reference catches up', () => {
  let now = 1000;
  const filter = createAcousticEchoFilter();
  const results = [];
  const coordinator = createMicEchoCoordinator({
    filter,
    delayMs: 250,
    clock: () => now,
    onMicrophone: (pcm) => results.push(filter.inspectMicrophone(pcm)),
  });
  const system = makeSignal(SAMPLE_RATE * 2);
  const leakedMic = scaledSlice(system, 30000, 2048, 0.3);

  assert.equal(filter.inspectMicrophone(leakedMic).suppress, false, 'reference is unavailable at mic arrival');
  assert.equal(coordinator.enqueueMicrophone(leakedMic), true);
  assert.equal(results.length, 0);

  now += 200;
  coordinator.observeSystem(system);
  assert.equal(results.length, 0, 'mic remains delayed until the causal safety window expires');

  now += 50;
  coordinator.flushReady();
  assert.equal(results.length, 1);
  assert.equal(results[0].suppress, true);
  assert.ok(results[0].correlation >= 0.82);
});

test('normal drain releases the delayed tail while clear discards it between sessions', () => {
  let now = 0;
  const processed = [];
  const filter = createAcousticEchoFilter();
  const coordinator = createMicEchoCoordinator({
    filter,
    delayMs: 250,
    clock: () => now,
    onMicrophone: (pcm) => processed.push(pcm),
  });

  const first = Buffer.alloc(960, 1);
  coordinator.enqueueMicrophone(first);
  assert.equal(coordinator.drain(), 1);
  assert.deepEqual(processed, [first]);

  const stale = Buffer.alloc(960, 2);
  coordinator.enqueueMicrophone(stale);
  coordinator.clear();
  now += 1000;
  assert.equal(coordinator.flushReady(), 0);
  assert.deepEqual(processed, [first]);
});

test('mic delay queue is byte-bounded', () => {
  const filter = createAcousticEchoFilter();
  const coordinator = createMicEchoCoordinator({ filter, maxBytes: 100, onMicrophone: () => {} });
  assert.equal(coordinator.enqueueMicrophone(Buffer.alloc(60)), true);
  assert.equal(coordinator.enqueueMicrophone(Buffer.alloc(50)), false);
  assert.equal(coordinator.queuedBytes, 60);
  coordinator.clear();
  assert.equal(coordinator.queuedBytes, 0);
});

test('oldest queued mic chunk schedules an automatic deadline flush', () => {
  let now = 100;
  let scheduled = null;
  const processed = [];
  const coordinator = createMicEchoCoordinator({
    filter: createAcousticEchoFilter(),
    delayMs: 250,
    clock: () => now,
    setTimer: (callback, delay) => {
      scheduled = { callback, delay, unref() {} };
      return scheduled;
    },
    clearTimer: () => { scheduled = null; },
    onMicrophone: (pcm) => processed.push(pcm),
  });
  const pcm = Buffer.alloc(960, 3);
  assert.equal(coordinator.enqueueMicrophone(pcm), true);
  assert.equal(scheduled.delay, 250);
  now = 350;
  scheduled.callback();
  assert.deepEqual(processed, [pcm]);
  assert.equal(coordinator.queuedBytes, 0);
});

test('expired audio flushes before admission capacity is checked', () => {
  let now = 0;
  const processed = [];
  const coordinator = createMicEchoCoordinator({
    filter: createAcousticEchoFilter(),
    delayMs: 250,
    maxBytes: 100,
    clock: () => now,
    onMicrophone: (pcm) => processed.push(pcm),
  });
  const expired = Buffer.alloc(60, 1);
  const next = Buffer.alloc(50, 2);
  assert.equal(coordinator.enqueueMicrophone(expired), true);
  now = 250;
  assert.equal(coordinator.enqueueMicrophone(next), true);
  assert.deepEqual(processed, [expired]);
  assert.equal(coordinator.queuedBytes, 50);
  coordinator.clear();
});
