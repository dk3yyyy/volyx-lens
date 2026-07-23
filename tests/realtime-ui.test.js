const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getDefaultSettings } = require('../src/provider-config');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('defaults enable realtime Whisper with a bounded batch fallback', () => {
  const settings = getDefaultSettings();
  assert.deepEqual(settings.transcription, {
    mode: 'realtime',
    realtimeProvider: 'openai',
    realtimeModel: 'gpt-realtime-whisper',
    deepgramModel: 'nova-3',
    azureRealtimeDeployment: '',
    fallbackModel: 'gpt-4o-mini-transcribe',
    geminiFallbackModel: 'gemini-3.5-flash',
    offlineEnabled: false,
    offlineCloudFallback: false,
    language: '',
    delay: 'low',
  });
});

test('settings UI exposes realtime transcription controls and persists them', () => {
  for (const id of ['stt-mode', 'stt-realtime-provider', 'stt-azure-deployment', 'stt-deepgram-model', 'stt-language', 'stt-delay', 'stt-fallback-model', 'stt-gemini-fallback-model', 'stt-offline-enabled', 'stt-offline-cloud-fallback']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(renderer, new RegExp(`\\$\\('#${id}'\\)`));
  }
  assert.match(html, /id="key-deepgram"/);
  assert.match(renderer, /deepgram: 'Deepgram API key'/);
  assert.match(renderer, /'deepgram', 'azureRealtime'/);
  assert.match(renderer, /settings\.transcription/);
});

test('renderer receives transcript events but never receives realtime credentials', () => {
  assert.match(preload, /transcript:partial/);
  assert.match(preload, /transcription:state/);
  assert.doesNotMatch(preload, /realtime[^\n]*(apiKey|Authorization)/i);
  assert.match(main, /RealtimeTranscriptionManager/);
  assert.match(main, /render-process-gone[\s\S]*setCapturing\(false\)/);
});

test('live transcript workspace identifies both channels and distinguishes partial text', () => {
  assert.match(html, /id="transcript-workspace"/);
  assert.match(renderer, /transcript:partial/);
  assert.match(renderer, /turn\.channel === 'you'/);
  assert.match(renderer, /turn\.partial \|\| turn\.pendingText \? 'Listening…'/);
  assert.match(renderer, /activeTurn\.pendingText = partial\.text/);
});

test('toolbar has a compact icon-only listening control with accessible dynamic state text', () => {
  assert.match(html, /id="stop-btn"[^>]*aria-label="Start Listening"/);
  assert.match(html, /id="stop-btn"[^>]*data-icon-only="true"/);
  assert.doesNotMatch(html, /class="listen-label"/);
  assert.match(renderer, /icon\(active \? 'stop-square' : 'mic'/);
  assert.match(renderer, /active \? 'Stop Listening' : 'Start Listening'/);
  assert.match(renderer, /button\.title = label/);
  assert.match(renderer, /button\.setAttribute\('aria-label', label\)/);
});
