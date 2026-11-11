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

test('settings:get tells the renderer whether local whisper can start', () => {
  assert.match(main, /function offlineWhisperStatus\(\)/);
  assert.match(main, /resolveWhisperBinary\(\{/);
  assert.match(main, /settings:get', \(\) => \(\{ \.\.\.store\.getPublicSettings\(\), offlineWhisper: offlineWhisperStatus\(\) \}\)/);
});

test('settings:set refuses to store offline mode without a binary', () => {
  const start = main.indexOf("handleTrusted('settings:set'");
  const block = main.slice(start, start + 900);
  assert.match(block, /offlineWhisper\.available !== true/);
  assert.match(block, /offlineEnabled: false/);
});

test('the settings UI disables the toggle and explains why', () => {
  assert.match(html, /id="stt-offline-note"/);
  assert.match(renderer, /offlineToggle\.disabled = offlineUnavailable/);
  assert.match(renderer, /whisper-server binary, which this build does not include/);
});

test('advertised copy says the binary is required', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /requires a `whisper-server` binary/);
  const site = fs.readFileSync(path.join(root, 'website', 'index.html'), 'utf8');
  assert.match(site, /macOS needs a configured whisper-server binary/);
});

test('every offered whisper model has a published file', () => {
  const select = html.match(/<select id="stt-whisper-model">([\s\S]*?)<\/select>/);
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
