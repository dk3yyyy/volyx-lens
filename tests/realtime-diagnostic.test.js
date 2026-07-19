const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runRealtimeDiagnostic, LiveRealtimeDiagnostic } = require('../src/realtime-diagnostic');

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() { this.readyState = FakeWebSocket.OPEN; this.emit('open'); }
  send(value) { this.sent.push(JSON.parse(value)); }
  message(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.emit('close', 1000); }
  terminate() { this.readyState = FakeWebSocket.CLOSED; }
}

function azureSettings(overrides = {}) {
  return {
    apiKeys: { azure: 'diagnostic-secret-key' },
    endpoints: { azure: 'https://demo.openai.azure.com/openai/v1' },
    transcription: {
      mode: 'realtime',
      realtimeProvider: 'azure',
      realtimeModel: 'gpt-realtime-whisper',
      azureRealtimeDeployment: 'volyx-lens-whisper',
      language: 'auto',
      delay: 'low',
      ...overrides,
    },
  };
}

test.beforeEach(() => { FakeWebSocket.instances = []; });

test('diagnostic accepts an Azure transcription session without sending audio or exposing credentials', async () => {
  const resultPromise = runRealtimeDiagnostic({ settings: azureSettings(), WebSocketImpl: FakeWebSocket });
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'wss://demo.openai.azure.com/openai/v1/realtime?intent=transcription');
  assert.equal(socket.options.headers['api-key'], 'diagnostic-secret-key');
  assert.equal(socket.url.includes('diagnostic-secret-key'), false);

  socket.open();
  assert.equal(socket.sent.length, 1);
  const transcription = socket.sent[0].session.audio.input.transcription;
  assert.equal(transcription.model, 'volyx-lens-whisper');
  assert.equal('language' in transcription, false);
  socket.message({ type: 'session.updated' });

  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.code, 'session_accepted');
  assert.equal(JSON.stringify(result).includes('diagnostic-secret-key'), false);
});

test('diagnostic maps HTTP authentication failures to an actionable sanitized result', async () => {
  const resultPromise = runRealtimeDiagnostic({ settings: azureSettings(), WebSocketImpl: FakeWebSocket });
  const socket = FakeWebSocket.instances[0];
  socket.emit('unexpected-response', {}, { statusCode: 401 });
  const result = await resultPromise;
  assert.deepEqual({ ok: result.ok, stage: result.stage, status: result.status, code: result.code }, {
    ok: false,
    stage: 'http',
    status: 401,
    code: 'http_401',
  });
  assert.match(result.message, /API key does not match/);
});

test('diagnostic returns provider session errors and redacts a leaked key', async () => {
  const resultPromise = runRealtimeDiagnostic({ settings: azureSettings(), WebSocketImpl: FakeWebSocket });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.message({ type: 'error', error: { code: 'invalid_value', message: "Invalid key diagnostic-secret-key and language 'auto'." } });
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'session');
  assert.equal(result.code, 'invalid_value');
  assert.match(result.message, /\[REDACTED\]/);
  assert.equal(JSON.stringify(result).includes('diagnostic-secret-key'), false);
});

test('diagnostic times out and closes a socket that never opens', async () => {
  const result = await runRealtimeDiagnostic({ settings: azureSettings(), WebSocketImpl: FakeWebSocket, timeoutMs: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'connection');
  assert.equal(result.code, 'diagnostic_timeout');
  assert.equal(FakeWebSocket.instances[0].readyState, FakeWebSocket.CLOSED);
});

test('diagnostic fails configuration before opening a socket', async () => {
  const settings = azureSettings();
  settings.apiKeys.azure = '';
  const result = await runRealtimeDiagnostic({ settings, WebSocketImpl: FakeWebSocket });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'configuration');
  assert.equal(FakeWebSocket.instances.length, 0);
});

class FakeLiveManager {
  static instances = [];
  constructor(options) { this.options = options; this.buffers = []; FakeLiveManager.instances.push(this); }
  async start() {}
  append(channel, buffer) { this.buffers.push({ channel, buffer }); return true; }
  async stop() {
    this.options.onState({ status: 'activity', activity: 'processing', channel: 'you' });
    this.options.onFinal({ channel: 'you', text: 'Live diagnostic transcript.' });
  }
}

test('live diagnostic streams bounded PCM through one channel and returns transcript telemetry', async () => {
  FakeLiveManager.instances = [];
  const diagnostic = new LiveRealtimeDiagnostic({ settings: azureSettings(), ManagerImpl: FakeLiveManager });
  const started = await diagnostic.start();
  assert.equal(started.ok, true);
  const manager = FakeLiveManager.instances[0];
  assert.deepEqual(manager.options.enabledChannels, ['you']);
  const pcm = Buffer.alloc(24000 * 2 * 2, 1);
  assert.equal(diagnostic.append(pcm, { sourceSampleRate: 48000, level: 0.42 }), true);
  const result = await diagnostic.finish();
  assert.equal(result.ok, true);
  assert.equal(result.transcript, 'Live diagnostic transcript.');
  assert.equal(result.sourceSampleRate, 48000);
  assert.equal(result.targetSampleRate, 24000);
  assert.equal(result.durationMs, 2000);
  assert.equal(result.commitCount, 1);
  assert.equal(result.endpointHost, 'demo.openai.azure.com');
  assert.equal(JSON.stringify(result).includes('diagnostic-secret-key'), false);
});

test('live diagnostic fails clearly when audio arrives but no transcript is returned', async () => {
  class SilentManager extends FakeLiveManager { async stop() { this.options.onState({ status: 'item_failed', message: 'No speech.' }); } }
  const diagnostic = new LiveRealtimeDiagnostic({ settings: azureSettings(), ManagerImpl: SilentManager });
  await diagnostic.start();
  diagnostic.append(Buffer.alloc(24000 * 2 * 2, 1), { sourceSampleRate: 44100, level: 0.1 });
  const result = await diagnostic.finish();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_transcript');
  assert.match(result.message, /Audio reached the provider/);
});
