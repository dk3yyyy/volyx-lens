const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mulberry32, decodeWav, silencePcm, noisePcm, scaleToRms, mixPcm, insertSilenceGap,
  buildFixtures, fixtureHash, staleFixtureIds, buildRow, evaluatePcm, summarize, coverageIssue, normalizeText, wer,
  THRESHOLDS, checkThresholds,
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
    meanStartErrorMs: 400, meanEndErrorMs: 1600, werMean: 0.45,
  };
  const violations = checkThresholds(summary);
  assert.deepEqual(violations.map((v) => v.name), ['emptyTurnRate', 'falseNegativeRate', 'meanStartErrorMs', 'meanEndErrorMs', 'truncationCount', 'wer']);
});

test('coverageIssue reports a partial evaluation and passes on the full set', () => {
  const full = buildFixtures();
  const speech = full.filter((f) => f.kind === 'speech');
  // One missing TTS voice: drop a single speech fixture.
  const partial = full.filter((f) => f.id !== 'accent-us');
  const issue = coverageIssue(partial, full);
  assert.ok(issue, 'missing a speech fixture must be reported');
  assert.match(issue, /1 of 20 speech fixture\(s\) skipped/);
  // Full set: no issue.
  assert.equal(coverageIssue(full, full), null);
  // Zero speech evaluated is the vacuous-pass case: it must be reported.
  const emptiesOnly = full.filter((f) => f.kind === 'empty');
  assert.ok(coverageIssue(emptiesOnly, full), 'no speech fixtures evaluated must be reported');
  // Robust against a caller that passes the same fixtures twice.
  assert.equal(coverageIssue(speech, speech), null);
});

test('THRESHOLDS covers every enforced metric', () => {
  for (const key of ['emptyTurnRate', 'falseNegativeRate', 'meanStartErrorMs', 'meanEndErrorMs', 'truncationCount', 'wer']) {
    assert.equal(typeof THRESHOLDS[key], 'number', `missing threshold ${key}`);
  }
});

test('fixtureHash is stable for identical definitions and changes with any parameter', () => {
  const base = buildFixtures().find((f) => f.id === 'noise-white-6');
  assert.equal(fixtureHash(base), fixtureHash({ ...base }));
  assert.notEqual(fixtureHash(base), fixtureHash({ ...base, snrDb: 12 }));
  assert.notEqual(fixtureHash(base), fixtureHash({ ...base, text: 'a different sentence.' }));
  assert.notEqual(fixtureHash(base), fixtureHash({ ...base, voice: 'Daniel' }));
  assert.notEqual(fixtureHash(base), fixtureHash({ ...base, rate: 120 }));
});

test('integration: endErrMs is a finite number through evaluatePcm -> buildRow -> summarize', () => {
  // Mirror a speech fixture: LEAD_MS lead, 1s of loud speech, TRAIL_MS silence.
  // The trail (1500ms) exceeds the VAD hangover (silenceMs 700), so the final
  // utterance closes naturally and the end boundary is actually measurable.
  const fixture = { id: 'int-end-test', category: 'technical', kind: 'speech', text: 'integration fixture' };
  const lead = silencePcm(0.5, 24000);
  const burst = Buffer.alloc(24000 * 2); // 1 second
  for (let i = 0; i < burst.length; i += 2) burst.writeInt16LE(18000, i);
  const trail = silencePcm(1.5, 24000);
  const result = evaluatePcm(Buffer.concat([lead, burst, trail]), { sampleRate: 24000, fixture });
  const row = buildRow(fixture, result);
  // Regression guard: this was NaN (object minus number) or null (trail shorter
  // than the hangover, later Math.abs(null) === 0) before the fix.
  assert.equal(Number.isFinite(row.endErrMs), true, `endErrMs must be finite, got ${row.endErrMs}`);
  assert.ok(row.endErrMs < 0, 'detected end trails the true end by the VAD hangover');
  assert.ok(Math.abs(row.endErrMs) <= 1200, `end error within hangover tolerance, got ${row.endErrMs}`);
  const summary = summarize([row]);
  assert.equal(Number.isFinite(summary.meanEndErrorMs), true, 'meanEndErrorMs must be finite');
  assert.equal(summary.truncationCount, 0, 'natural close must not count as truncated');
});

test('integration: an early-close (false gap) is counted as truncated', () => {
  // Speech that closes early and never reopens: lead, 1s speech, then 4.5s of
  // silence. The detector closes at ~speech end + hangover (~2.2s), but the
  // expected end is durationMs - TRAIL_MS (6s - 1.5s = 4.5s), so endErrMs is
  // strongly positive and exceeds the truncation tolerance.
  const fixture = { id: 'int-trunc-test', category: 'technical', kind: 'speech', text: 'truncation fixture' };
  const lead = silencePcm(0.5, 24000);
  const burst = Buffer.alloc(24000 * 2); // 1 second
  for (let i = 0; i < burst.length; i += 2) burst.writeInt16LE(18000, i);
  const gap = silencePcm(4.5, 24000); // long trailing silence, no speech after
  const result = evaluatePcm(Buffer.concat([lead, burst, gap]), { sampleRate: 24000, fixture });
  const row = buildRow(fixture, result);
  assert.equal(Number.isFinite(row.endErrMs), true);
  const summary = summarize([row]);
  assert.ok(summary.truncationCount >= 1, `early close must be truncated, endErrMs=${row.endErrMs}`);
});

test('staleFixtureIds refuses report-only evaluation of an incompatible cache', () => {
  const fixtures = buildFixtures();
  const current = fixtures.map((f) => ({ id: f.id, hash: fixtureHash(f) }));
  assert.deepEqual(staleFixtureIds(fixtures, current), [], 'current manifest has no stale fixtures');
  const oneStale = current.map((e) => e.id === 'noise-white-6' ? { id: e.id, hash: 'stale-hash' } : e);
  assert.deepEqual(staleFixtureIds(fixtures, oneStale), ['noise-white-6']);
  assert.deepEqual(staleFixtureIds(fixtures, fixtures.map((f) => f.id)), fixtures.map((f) => f.id), 'legacy id-only manifest is all stale');
  assert.deepEqual(staleFixtureIds(fixtures, []), fixtures.map((f) => f.id), 'missing manifest is all stale');
});

test('evaluatePcm keeps speech continuing after the maxUtteranceMs cap', () => {
  const burst = Buffer.alloc(24000 * 2); // 1 second
  for (let i = 0; i < burst.length; i += 2) burst.writeInt16LE(18000, i);
  const result = evaluatePcm(burst, { vadOptions: { maxUtteranceMs: 300 } });
  assert.ok(result.utterances.length > 1, 'post-cap speech must not be dropped');
  assert.equal(result.utterances[0].forced, true);
  assert.ok(result.utterances[0].endMs <= 500);
  assert.equal(result.utterances.at(-1).forced, false);
  assert.ok(result.utterances.at(-1).endMs >= 950, 'continuation reaches the end of the buffer');
});
