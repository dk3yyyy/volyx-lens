'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const { defaultBinariesDir } = require('../src/whisper-sidecar');
const { fileFor, unavailableReason } = require('../src/whisper-models');

test('the sidecar exposes the binaries directory it resolves', () => {
  assert.equal(typeof defaultBinariesDir, 'function');
  assert.match(defaultBinariesDir('/tmp/user-data'), /whisper-binaries/);
});

test('settings:get tells the renderer whether local speech engines can start', () => {
  assert.match(main, /function offlineWhisperStatus\(\)/);
  assert.match(main, /resolveWhisperBinary\(\{/);
  assert.match(main, /handleTrusted\('settings:get', \(\) => \(\{[\s\S]*offlineWhisper: offlineWhisperStatus\(\),[\s\S]*localSpeech: localSpeechRuntimeStatus\(\),[\s\S]*speechModels: speechModelsWithStatus\(\)/);
});

test('settings:set refuses to store offline mode without a binary', () => {
  const start = main.indexOf("handleTrusted('settings:set'");
  const block = main.slice(start, start + 900);
  assert.match(block, /localSpeech\.available !== true/);
  assert.match(block, /offlineEnabled: false/);
});

test('offline-first pipeline routing is applied before any cloud realtime manager starts', () => {
  const start = main.indexOf('async function startTranscriptionPipeline()');
  const end = main.indexOf('async function stopTranscriptionPipeline(', start);
  assert.ok(start >= 0 && end > start, 'transcription pipeline functions exist');
  const block = main.slice(start, end);
  assert.match(block, /resolveTranscriptionMode\(\{ \.\.\.settings, speechModels: speechModelsWithStatus\(\) \}/);
  const batchBranch = block.indexOf("transcriptionRoute === 'batch'");
  const localStreamBranch = block.indexOf("transcriptionRoute === 'local-stream'");
  const realtimeStart = block.indexOf("transcriptionMode = 'realtime'");
  assert.ok(batchBranch >= 0, 'offline batch routing has an explicit branch');
  assert.ok(localStreamBranch > batchBranch, 'streaming routing sits beside the batch branch');
  assert.ok(realtimeStart > batchBranch && realtimeStart > localStreamBranch, 'cloud realtime starts only after offline routing is handled');
});

test('the settings UI disables the toggle and explains why', () => {
  assert.match(html, /id="stt-offline-note"/);
  assert.match(renderer, /offlineToggle\.disabled = offlineUnavailable/);
  assert.match(renderer, /localSpeech\.gguf && localSpeech\.gguf\.reason/);
  assert.match(renderer, /offlineToggle\.disabled = offlineUnavailable/);
});

test('advertised copy says the binary is required', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /requires a `whisper-server` binary/);
  const site = fs.readFileSync(path.join(root, 'website', 'index.html'), 'utf8');
  assert.match(site, /macOS needs a configured whisper-server binary/);
});

test('every offered whisper model has a published file', () => {
  const select = html.match(/<select id="stt-whisper-model"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, 'renderer/index.html has the whisper model selector');
  const values = [...select[1].matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(values.length > 0, 'the selector offers at least one model');
  assert.equal(values.includes('base.en'), true, 'base.en stays available');
  for (const value of values) {
    assert.ok(fileFor(value), `${value} is offered but has no published file`);
    assert.equal(unavailableReason(value), '', `${value} is offered but is explicitly unavailable`);
  }
  assert.equal(values.includes('large-v3.en'), false);
  assert.equal(values.includes('distil-large-v3'), false);
});
