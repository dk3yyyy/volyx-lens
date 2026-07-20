const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

test('Settings exposes accessible connection and end-to-end live diagnostics with billing disclosure', () => {
  assert.match(html, /id="test-realtime-btn"/);
  assert.match(html, /id="test-live-transcription-btn"/);
  assert.match(html, /id="realtime-test-result"[^>]*role="status"/);
  assert.match(html, /short no-audio session/);
  assert.match(html, /records and streams five seconds/);
  assert.match(html, /billing may apply/);
});

test('diagnostic IPC is narrow and credentials never cross from renderer to main', () => {
  assert.match(preload, /testRealtime:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('transcription:test'\)/);
  assert.match(preload, /startLiveTranscriptionTest:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('transcription:live-test-start'\)/);
  assert.match(preload, /liveTranscriptionPcm:\s*\(arrayBuffer, metadata\)\s*=>\s*ipcRenderer\.send\('transcription:live-test-audio'/);
  assert.doesNotMatch(preload, /testRealtime:\s*\([^)]*(key|endpoint|settings)/i);
  assert.match(main, /runRealtimeDiagnostic\(\{ settings: store\.getSettings\(\) \}\)/);
  assert.match(main, /new LiveRealtimeDiagnostic\(\{ settings: store\.getSettings\(\) \}\)/);
  assert.match(main, /handleTrusted\('transcription:live-test-start', \(\) => startLiveRealtimeDiagnostic\(\)\)/);
});

test('renderer saves settings, captures five seconds, disables conflicting controls, and renders results as text', () => {
  assert.match(renderer, /#test-realtime-btn/);
  assert.match(renderer, /#test-live-transcription-btn/);
  assert.match(renderer, /await saveSettings\(\)/);
  assert.match(renderer, /await volyxLens\.requestPermission\('microphone'\)/);
  assert.match(renderer, /await volyxLens\.startLiveTranscriptionTest\(\)/);
  assert.ok(renderer.indexOf("await volyxLens.requestPermission('microphone')") < renderer.indexOf('await volyxLens.startLiveTranscriptionTest()'));
  assert.match(renderer, /volyxLens\.liveTranscriptionPcm\(buffer, metadata\)/);
  assert.match(renderer, /await volyxLens\.finishLiveTranscriptionTest\(\)/);
  assert.match(renderer, /for \(let remaining = 5/);
  assert.match(renderer, /listenButton\.disabled = true/);
  assert.match(renderer, /resultEl\.textContent/);
  assert.doesNotMatch(renderer, /resultEl\.innerHTML/);
});
