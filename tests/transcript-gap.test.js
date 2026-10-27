'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');

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
