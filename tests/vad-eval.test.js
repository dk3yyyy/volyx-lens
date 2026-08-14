const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mulberry32, decodeWav, silencePcm, noisePcm, scaleToRms, mixPcm, insertSilenceGap,
  buildFixtures, evaluatePcm, normalizeText, wer, THRESHOLDS, checkThresholds,
} = require('../scripts/vad-accuracy-eval');
const { pcmToWav } = require('../src/wav');

test('mulberry32 is deterministic for the same seed', () => {
  const a = mulberry32(42); const b = mulberry32(42);
  const first = Array.from({ length: 5 }, () => a());
  const second = Array.from({ length: 5 }, () => b());
  assert.deepEqual(first, second);
  const c = mulberry32(43);
  assert.notDeepEqual(Array.from({ length: 5 }, () => c()), first);
});

test('WAV encode/decode round-trips mono 16-bit PCM', () => {
  const pcm = Buffer.alloc(4800);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE((i / 2) % 2000 - 1000, i);
  const wav = pcmToWav(pcm, 24000);
  const decoded = decodeWav(wav);
  assert.equal(decoded.sampleRate, 24000);
  assert.deepEqual(decoded.pcm, pcm);
});

test('wer scores exact, substituted, inserted, and disjoint hypotheses', () => {
  assert.equal(wer('the quick brown fox', 'the quick brown fox'), 0);
  assert.equal(wer('', ''), 0);
  assert.equal(wer('', 'hello world'), 1);
  assert.equal(wer('the quick brown fox', 'the quick green fox'), 0.25);
  assert.equal(wer('the quick fox', 'the quick brown fox'), 1 / 3); // one insertion over three reference words
  assert.equal(wer('hello world', 'goodbye moon'), 1);
});

test('normalizeText strips punctuation and collapses whitespace', () => {
  assert.equal(normalizeText('  Hello,   WORLD!  '), 'hello world');
  assert.equal(normalizeText('gpt-4o-mini'), 'gpt 4o mini');
});

test('mixPcm keeps the primary length and clips at int16 bounds', () => {
  const primary = Buffer.alloc(4800);
  primary.writeInt16LE(30000, 0);
  const overlay = Buffer.alloc(4800);
  overlay.writeInt16LE(30000, 0);
  const mixed = mixPcm(primary, overlay, 0, 24000);
  assert.equal(mixed.length, primary.length);
  assert.equal(mixed.readInt16LE(0), 32767); // clipped
  assert.equal(mixed.readInt16LE(2), 0); // untouched sample
});

test('insertSilenceGap lengthens the buffer by the gap duration', () => {
  const pcm = silencePcm(0.1, 24000);
  const gapped = insertSilenceGap(pcm, 1000, 24000);
  assert.equal(gapped.length, pcm.length + 24000 * 2);
});

test('the fixture manifest covers every planned category plus empty turns', () => {
  const fixtures = buildFixtures();
  const categories = new Set(fixtures.map((f) => f.category));
  for (const category of ['accents', 'technical', 'numbers', 'long-pauses', 'cross-talk', 'noise', 'empty']) {
    assert.ok(categories.has(category), `missing category ${category}`);
  }
  assert.ok(fixtures.some((f) => f.kind === 'empty'));
  assert.ok(fixtures.every((f) => f.kind === 'speech' ? f.text && f.text.length > 3 : true));
  const ids = fixtures.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'fixture ids must be unique');
});

test('evaluatePcm stays quiet for silence and near-threshold noise', () => {
  assert.equal(evaluatePcm(silencePcm(1, 24000)).utterances.length, 0);
  const quiet = noisePcm(1.5, 24000, 'white', 7, 0.001);
  assert.equal(evaluatePcm(quiet).utterances.length, 0);
});

test('evaluatePcm detects one loud burst and reports the utterance window', () => {
  const burst = Buffer.alloc(24000 * 2); // 1 second
  for (let i = 0; i < burst.length; i += 2) burst.writeInt16LE(18000, i);
  const result = evaluatePcm(burst);
  assert.equal(result.starts.length, 1);
  assert.equal(result.utterances.length, 1);
  assert.ok(Math.abs(result.utterances[0].startMs) <= 100);
  assert.ok(Math.abs(result.utterances[0].endMs - 1000) <= 150);
});

test('checkThresholds passes a clean summary and skips unmeasured WER', () => {
  const clean = {
    emptyTurnRate: 0, falseNegativeRate: 0, truncationCount: 0,
    meanStartErrorMs: 92, meanEndErrorMs: 0, werMean: null,
  };
  assert.deepEqual(checkThresholds(clean), []);
  assert.deepEqual(checkThresholds({ ...clean, werMean: 0.17 }), []);
});

test('checkThresholds flags regressions past the baseline limits', () => {
  const summary = {
    emptyTurnRate: 0.15, falseNegativeRate: 0.1, truncationCount: 3,
    meanStartErrorMs: 400, meanEndErrorMs: 250, werMean: 0.45,
  };
  const violations = checkThresholds(summary);
  assert.deepEqual(violations.map((v) => v.name), ['emptyTurnRate', 'falseNegativeRate', 'meanStartErrorMs', 'meanEndErrorMs', 'truncationCount', 'wer']);
});

test('THRESHOLDS covers every enforced metric', () => {
  for (const key of ['emptyTurnRate', 'falseNegativeRate', 'meanStartErrorMs', 'meanEndErrorMs', 'truncationCount', 'wer']) {
    assert.equal(typeof THRESHOLDS[key], 'number', `missing threshold ${key}`);
  }
});

test('evaluatePcm applies the maxUtteranceMs cap as a forced stop', () => {
  const burst = Buffer.alloc(24000 * 2); // 1 second
  for (let i = 0; i < burst.length; i += 2) burst.writeInt16LE(18000, i);
  const result = evaluatePcm(burst, { vadOptions: { maxUtteranceMs: 300 } });
  assert.equal(result.utterances.length, 1);
  assert.equal(result.utterances[0].forced, true);
  assert.ok(result.utterances[0].endMs <= 500);
});
