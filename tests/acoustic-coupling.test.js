'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAcousticCoupling, normalizeSpeakerMode } = require('../src/acoustic-coupling');
const { createEchoGapFill, pcmRms } = require('../src/echo-gap-fill');
const { findCrossTalkDuplicate } = require('../src/transcript-dedupe');

test('coupling stays inactive without bleed evidence (headphones)', () => {
  let now = 0;
  const coupling = createAcousticCoupling({ now: () => now });
  for (let index = 0; index < 100; index += 1) {
    coupling.observe(index % 3 ? 'local' : 'double-talk');
    now += 85;
  }
  assert.equal(coupling.active(), false);
});

test('coupling turns on after repeated bleed and expires after the window', () => {
  let now = 0;
  const coupling = createAcousticCoupling({ now: () => now, windowMs: 60000, minBleedChunks: 3 });
  coupling.observe('bleed');
  coupling.observe('bleed');
  assert.equal(coupling.active(), false);
  coupling.observe('bleed');
  assert.equal(coupling.active(), true);
  now += 60001;
  assert.equal(coupling.active(), false);
});

test('explicit speaker modes override the evidence', () => {
  const coupling = createAcousticCoupling({ mode: 'speakers' });
  assert.equal(coupling.active(), true);
  coupling.setMode('headphones');
  for (let index = 0; index < 10; index += 1) coupling.observe('bleed');
  assert.equal(coupling.active(), false);
  coupling.setMode('nonsense');
  assert.equal(coupling.status().mode, 'auto');
  assert.equal(normalizeSpeakerMode(undefined), 'auto');
});

test('reset clears the evidence', () => {
  const coupling = createAcousticCoupling();
  for (let index = 0; index < 5; index += 1) coupling.observe('bleed');
  assert.equal(coupling.active(), true);
  coupling.reset();
  assert.equal(coupling.active(), false);
});

// Why the gate exists: these are genuine answers that repeat the question.
// The dedupe removes them, which is only acceptable when speaker echo is present.
test('dedupe matches genuine read-back answers, so it must be gated', () => {
  const now = 1_000_000;
  const cases = [
    ['What is the deadline for the first milestone?', 'The deadline for the first milestone is Friday'],
    ['So we agreed the budget is fifty thousand pounds for phase one', 'Sorry, the budget is fifty thousand pounds for phase one, is that right?'],
  ];
  for (const [them, you] of cases) {
    const turns = [{ id: 1, turnId: 1, channel: 'them', text: them, ts: now - 3000 }];
    const match = findCrossTalkDuplicate(turns, { channel: 'you', text: you, ts: now }, new Map([[1, now - 3000]]), now);
    assert.ok(match, `expected the dedupe to match: ${you}`);
  }
});

function tone(samples, amplitude) {
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(index / 5) * amplitude), index * 2);
  }
  return pcm;
}

test('gap fill replaces echo inside speech with silence and drops it elsewhere', () => {
  let now = 0;
  const chunk = tone(2048, 8000);
  assert.ok(pcmRms(chunk) > 1000);
  const fill = createEchoGapFill({ now: () => now, hangoverMs: 300, holdMs: 1200 });

  assert.equal(fill.suppressed(chunk), null, 'echo before any speech is dropped');

  fill.routed(chunk);
  now += 85;
  const silence = fill.suppressed(chunk);
  assert.ok(Buffer.isBuffer(silence));
  assert.equal(silence.length, chunk.length);
  assert.equal(pcmRms(silence), 0);

  // The run can continue inside hangover, but only up to its byte budget.
  now += 85;
  assert.ok(fill.suppressed(chunk));
  fill.routed(chunk); // new routed audio starts a new budget
  now += 85;
  assert.ok(fill.suppressed(chunk));

  now += 400;
  assert.equal(fill.suppressed(chunk), null, 'outside hangover nothing is filled');
});

test('gap fill counts PCM duration, not wall-clock ticks', () => {
  let now = 0;
  // 100 ms cap at 1 kHz mono PCM16 = 200 bytes. All calls share one timestamp,
  // as queued drain chunks do.
  const fill = createEchoGapFill({ now: () => now, sampleRate: 1000, holdMs: 100 });
  const chunk = Buffer.alloc(100);
  fill.routed(tone(100, 8000));
  assert.equal(fill.suppressed(chunk).length, 100);
  assert.equal(fill.suppressed(chunk).length, 100);
  assert.equal(fill.suppressed(chunk), null, 'the cap is measured in sent audio');
});

test('quiet routed audio does not open the hangover', () => {
  let now = 0;
  const fill = createEchoGapFill({ now: () => now });
  fill.routed(tone(2048, 20));
  now += 50;
  assert.equal(fill.suppressed(tone(2048, 8000)), null);
});
