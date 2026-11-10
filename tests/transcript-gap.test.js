'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { drainPendingAudio, buildDrainGap } = require('../src/drain-batch-buffers');
const { AUDIO_SAMPLE_RATE, AUDIO_CHUNK_SAMPLES, AUDIO_CHUNK_DURATION_MS } = require('../src/audio-config');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const audioWorklet = fs.readFileSync(path.join(root, 'renderer', 'audio-worklet.js'), 'utf8');

test('a realtime failure emits a gap event for the audio that was not transcribed', () => {
  const start = main.indexOf('function activateBatchTranscription(');
  const block = main.slice(start, start + 900);
  assert.match(block, /send\('transcript:gap', \{ ts: Date\.now\(\)/);
});

test('the preload allowlist includes the gap channel', () => {
  assert.match(preload, /'transcript:gap'/);
});

test('the renderer keeps gaps in time order and clears them with the transcript', () => {
  assert.match(renderer, /volyxLens\.on\('transcript:gap'/);
  assert.match(renderer, /transcriptGaps\.push/);
  assert.match(renderer, /orderedRows\.slice\(-200\)/);
  assert.match(renderer, /function clearTranscriptWorkspace\(\) \{\n    transcriptTurns = \[\];\n    transcriptGaps = \[\];/);
});

test('the gap row is visible and keeps the type floor', () => {
  assert.match(styles, /\.transcript-gap \{[^}]*font-size: 10\.5px/);
  assert.match(renderer, /row\.className = 'transcript-gap'/);
  assert.match(renderer, /Transcription gap while realtime recovered/);
});

test('a draining stop that abandons channels records a bounded gap entry', async () => {
  const outcome = await drainPendingAudio({
    channels: ['you', 'them'],
    flush: async () => { throw new Error('provider still rejecting'); },
    hasPending: () => true,
    maxPasses: 2,
  });
  assert.deepEqual(outcome.abandoned, ['you', 'them']);
  const gap = buildDrainGap({
    abandoned: outcome.abandoned,
    droppedChunks: { you: 180, them: 40 },
    ts: 1_700_000_000_000,
  });
  assert.deepEqual(gap, {
    ts: 1_700_000_000_000,
    reason: 'drain-failed',
    channels: ['you', 'them'],
    durationMs: Math.round(180 * AUDIO_CHUNK_DURATION_MS),
  });
  // Fixed, small shape: no buffers, transcript text, or provider error crosses IPC.
  assert.deepEqual(Object.keys(gap).sort(), ['channels', 'durationMs', 'reason', 'ts']);
  assert.doesNotMatch(JSON.stringify(gap), /provider|rejecting/);
});

test('the drain gap duration is the longest dropped channel, not the sum', () => {
  // Both channels run concurrently, so the hole in the transcript timeline is the
  // longest lost buffer; adding them would overstate how much speech was missing.
  const gap = buildDrainGap({ abandoned: ['you', 'them'], droppedChunks: { you: 4, them: 30 }, ts: 1 });
  assert.equal(gap.durationMs, Math.round(30 * AUDIO_CHUNK_DURATION_MS));
});

test('the drain gap helper sanitises channels, counts, timestamps, and duration', () => {
  assert.equal(buildDrainGap(), null);
  assert.equal(buildDrainGap({ abandoned: ['me', 'audience'] }), null);
  const gap = buildDrainGap({
    abandoned: ['__proto__', 'them', 'them', 'you'],
    droppedChunks: { you: -5, them: 2, other: 1e9 },
    ts: Number.NaN,
  });
  assert.deepEqual(gap.channels, ['you', 'them'], 'only known channels, canonical order');
  assert.equal(gap.durationMs, Math.round(2 * AUDIO_CHUNK_DURATION_MS));
  assert.ok(Number.isInteger(gap.ts) && gap.ts > 0);
  const clamped = buildDrainGap({ abandoned: ['you'], droppedChunks: { you: 1e9 } });
  assert.equal(clamped.durationMs, 10 * 60 * 1000, 'duration stays bounded');
});

test('the audio chunk duration matches the capture worklet', () => {
  const match = /this\.chunkSize = (\d+);/.exec(audioWorklet);
  assert.ok(match, 'the worklet declares its frame size');
  assert.equal(Number(match[1]), AUDIO_CHUNK_SAMPLES);
  assert.equal(AUDIO_SAMPLE_RATE, 24000);
  assert.ok(Math.abs(AUDIO_CHUNK_DURATION_MS - (AUDIO_CHUNK_SAMPLES / AUDIO_SAMPLE_RATE) * 1000) < 1e-9);
});

test('the drain emits the gap next to the existing status line', () => {
  const start = main.indexOf('async function drainBatchBuffers()');
  assert.ok(start >= 0);
  const block = main.slice(start, main.indexOf('function handleSttError'));
  assert.match(block, /buildDrainGap\(\{ abandoned: outcome\.abandoned, droppedChunks \}\)/);
  assert.match(block, /send\('transcript:gap', gap\)/);
  assert.match(block, /Some speech captured just before the stop could not be transcribed/);
  // buffers and retryQueues can hold the same chunks after a failed flush, so the
  // duration estimate must not count that audio twice.
  assert.match(block, /Math\.max\(buffers\[channel\]\.length, retryQueues\[channel\]\.length\)/);
});

test('the renderer shows the drain reason and duration in the existing gap row', () => {
  assert.match(renderer, /function normalizeTranscriptGap\(event\)/);
  assert.match(renderer, /GAP_REASONS = new Set\(\['realtime-failed', 'drain-failed', 'realtime-drain-timeout'\]\)/);
  assert.match(renderer, /Transcription gap: about \$\{seconds\}s of \$\{speaker\}audio captured just before the stop was not transcribed/);
  assert.match(renderer, /Transcription gap: the last words may have been missed when transcription stopped/);
  assert.match(renderer, /transcriptGaps\.map\(\(gap\) => \(\{ \.\.\.gap, gap: true \}\)\)/);
  assert.match(renderer, /row\.className = 'transcript-gap'/);
});

test('main keeps the manager in the drain set until its async stop resolves', () => {
  const start = main.indexOf('async function stopTranscriptionPipeline(');
  const block = main.slice(start, main.indexOf('function routePcm'));
  assert.match(
    block,
    /drainingRealtimeManagers\.add\(manager\);\n    await manager\.stop\(\{ graceMs: 750 \}\);\n    drainingRealtimeManagers\.delete\(manager\);/,
    'the manager is a drain member for the whole shutdown, then removed',
  );
});

test('main still records a final that arrives while the manager drains', () => {
  const start = main.indexOf('      onFinal: (event) => {');
  const block = main.slice(start, main.indexOf('      onLateFinal:', start));
  assert.match(block, /drainingRealtimeManagers\.has\(manager\)/);
  assert.match(block, /recordTranscript\(event, generation, epoch\)/);
});

test('a final after the channel drain window emits one gap instead of disappearing', () => {
  const start = main.indexOf('      onLateFinal:');
  const block = main.slice(start, main.indexOf('      onState: (event) => {', start));
  assert.match(block, /reason: 'realtime-drain-timeout'/);
  assert.equal((block.match(/send\('transcript:gap'/g) || []).length, 1, 'one gap marker per late final');
  assert.match(block, /generation !== sessionGeneration \|\| epoch !== transcriptEpoch/);
});

test('fallback enters batch once and emits exactly one gap', () => {
  const start = main.indexOf('function activateBatchTranscription(');
  const block = main.slice(start, main.indexOf('function startTranscriptionPipeline('));
  assert.match(block, /if \(!state\.capturing \|\| transcriptionMode === 'batch'\) return;/);
  assert.equal((block.match(/send\('transcript:gap'/g) || []).length, 1);
});
