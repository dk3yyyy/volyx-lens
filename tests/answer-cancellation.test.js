const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('answer generation is user-cancellable and hard-time-bounded across the IPC boundary', () => {
  assert.match(html, /id="cancel-response"[^>]*>Stop<\/button>/);
  assert.match(preload, /cancelResponse: \(\) => ipcRenderer\.send\('llm:cancel'\)/);
  assert.match(preload, /'llm:canceled'/);
  assert.match(main, /FEATURE_REQUEST_TIMEOUT_MS = 120000/);
  assert.match(main, /new AbortController\(\)/);
  assert.match(main, /featureRequest\.controller\.abort\(\)/);
  assert.match(main, /ipcMain\.on\('llm:cancel'/);
  assert.match(renderer, /volyxLens\.cancelResponse\(\)/);
  assert.match(renderer, /volyxLens\.on\('llm:canceled'/);
});

test('session and application lifecycle cancel active provider work', () => {
  assert.match(main, /cancelActiveFeature\('new-session'/);
  assert.match(main, /cancelActiveFeature\('quit'/);
  assert.match(main, /cancelActiveFeature\('relaunch'/);
  assert.match(main, /sanitizeProviderError\(e, \{ timedOut:/);
});
