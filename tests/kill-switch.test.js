const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('toolbar exposes an explicit stop-all-and-quit button', () => {
  assert.match(html, /id="kill-btn"/);
  assert.match(html, /Stop all capture and quit Volyx Lens/);
  assert.match(renderer, /#kill-btn/);
  assert.match(renderer, /volyxLens\.quit\(\)/);
});

test('preload exposes only a narrow quit IPC action', () => {
  assert.match(preload, /quit:\s*\(\)\s*=>\s*ipcRenderer\.send\('app:quit'\)/);
});

test('main process kill switch stops capture before quitting', () => {
  assert.match(main, /function stopAllAndQuit/);
  assert.match(main, /function stopAllAndQuit[\s\S]*stopTranscriptionPipeline\(\{ immediate: true \}\)[\s\S]*app\.quit\(\)/);
  assert.match(main, /onTrusted\('app:quit',[^)]*stopAllAndQuit/);
});
