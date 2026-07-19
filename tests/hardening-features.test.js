const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const worklet = fs.readFileSync(path.join(root, 'renderer', 'audio-worklet.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const release = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-macos.yml'), 'utf8');
const prompts = fs.readFileSync(path.join(root, 'src', 'prompts.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('audio capture uses AudioWorklet instead of deprecated ScriptProcessorNode', () => {
  assert.match(renderer, /audioWorklet\.addModule\('audio-worklet\.js'\)/);
  assert.match(renderer, /new AudioWorkletNode\(context, 'volyx-lens-pcm-capture'/);
  assert.doesNotMatch(renderer, /createScriptProcessor/);
  assert.match(worklet, /registerProcessor\('volyx-lens-pcm-capture'/);
  assert.match(worklet, /new Int16Array/);
});

test('UI exposes per-channel audio health, meters, latency, duration, retry, and device controls', () => {
  for (const id of ['audio-health', 'mic-health', 'system-health', 'mic-meter', 'system-meter', 'connection-count', 'session-duration', 'transcript-latency', 'retry-realtime-btn', 'audio-input-device', 'audio-mic-enabled', 'audio-system-enabled', 'audio-session-count', 'audio-sensitivity', 'audio-silence']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(renderer, /enumerateDevices\(\)/);
  assert.match(renderer, /volyxLens\.retryRealtime\(\)/);
  assert.match(main, /handleTrusted\('transcription:retry'/);
  assert.match(main, /async function retryTranscription\(\)[\s\S]*await stopTranscriptionPipeline\(\{ immediate: true \}\)[\s\S]*startTranscriptionPipeline\(\)/);
  assert.match(main, /powerMonitor\.on\('suspend'/);
});

test('Assist context is explicit and maps screen, conversation, and combined modes safely', () => {
  assert.match(html, /id="assist-context"/);
  assert.match(html, /Screen \+ conversation/);
  assert.match(html, /Conversation only/);
  assert.match(html, /Screen only/);
  assert.match(renderer, /assist-screen/);
  assert.match(renderer, /assist-conversation/);
  assert.match(prompts, /'assist-screen':[\s\S]*needsScreen: true/);
  assert.match(prompts, /'assist-conversation':[\s\S]*needsScreen: false/);
  assert.match(prompts, /Use only the supplied transcript/);
});

test('renderer never receives saved credential values and supports explicit replacement or removal', () => {
  assert.match(main, /store\.getPublicSettings\(\)/);
  assert.match(main, /store\.updateSettingsAndApiKeys\(patch, updates/);
  assert.match(html, /safeStorage \/ macOS Keychain/);
  assert.match(html, /class="key-clear"/);
  assert.match(renderer, /apiKeyUpdates/);
  assert.doesNotMatch(renderer, /settings\.apiKeys\.[a-z]+\s*=/);
});

test('session limits use a serialized idempotent main-process capture stop', () => {
  assert.match(preload, /captureStop: \(\) => ipcRenderer\.invoke\('capture:stop'\)/);
  assert.match(main, /handleTrusted\('capture:stop', \(\) => setCapturing\(false\)\)/);
  assert.match(main, /captureLimitTimer = setTimeout[\s\S]*setCapturing\(false\)/);
  assert.match(main, /captureTransition = captureTransition\.then\(reconcileCaptureState/);
});

test('CI checkouts do not persist repository credentials', () => {
  assert.equal((ci.match(/persist-credentials: false/g) || []).length, 2);
  assert.equal((release.match(/persist-credentials: false/g) || []).length, 1);
});

test('Electron runtime and packaging enable sandbox, ASAR, hardened runtime, and navigation restrictions', () => {
  assert.match(main, /sandbox: true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /will-navigate/);
  assert.equal(pkg.build.asar, true);
  assert.equal(pkg.build.mac.hardenedRuntime, true);
  assert.match(pkg.build.mac.entitlements, /entitlements\.mac\.plist$/);
});
