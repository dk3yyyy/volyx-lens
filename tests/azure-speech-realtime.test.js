'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  AzureSpeechRealtimeChannel,
  buildAzureSpeechUrl,
  buildSpeechConfigMessage,
  buildAudioMessage,
  parseAzureSpeechMessage,
  recognitionLocale,
} = require('../src/azure-speech-realtime');
const { RealtimeTranscriptionManager } = require('../src/realtime-stt');

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.bufferedAmount = 0;
    this.terminated = false;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  send(payload) { this.sent.push(Buffer.isBuffer(payload) ? payload : String(payload)); }
  close() { this.readyState = 3; this.emit('close', 1000, Buffer.from('closed')); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close', 1006, Buffer.from('terminated')); }
  remoteClose(code = 1000, reason = 'remote close') { this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
}

function buildChannel(overrides = {}) {
  const events = { partial: [], final: [], errors: [], states: [], latency: [] };
  const channel = new AzureSpeechRealtimeChannel({
    apiKey: 'speech-secret-key',
    channel: 'them',
    region: 'eastus',
    language: '',
    sampleRate: 24000,
    WebSocketImpl: FakeWebSocket,
    onPartial: (event) => events.partial.push(event),
    onFinal: (event) => events.final.push(event),
    onError: (error) => events.errors.push(error),
    onState: (event) => events.states.push(event),
    onLatency: (event) => events.latency.push(event),
    ...overrides,
  });
  return { channel, events };
}

test.beforeEach(() => { FakeWebSocket.instances = []; });

test('Azure Speech URL uses the conversation endpoint with the bare region and sample rate', () => {
  const url = buildAzureSpeechUrl({ region: 'eastus', language: '', sampleRate: 24000 });
  assert.equal(url, 'wss://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?format=simple&language=auto&profanity=masked&X-SampleRate=24000');
});

test('recognition locale maps empty and auto languages to automatic detection', () => {
  assert.equal(recognitionLocale(''), 'auto');
  assert.equal(recognitionLocale('auto'), 'auto');
  assert.equal(recognitionLocale(' Automatic '), 'auto');
  assert.equal(recognitionLocale('EN'), 'en');
});

test('channel authenticates via Ocp-Apim-Subscription-Key and sends the speech.config message first', async () => {
  const { channel, events } = buildChannel({ phrases: ['Volyx Lens'] });
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];

  assert.match(socket.url, /^wss:\/\/eastus\.stt\.speech\.microsoft\.com\/speech\/recognition\/conversation\/cognitiveservices\/v1/);
  assert.equal(socket.options.headers['Ocp-Apim-Subscription-Key'], 'speech-secret-key');
  assert.equal(socket.options.headers['X-ConnectionId'], socket.options.headers['X-ConnectionId']);
  assert.doesNotMatch(socket.url, /speech-secret-key/);

  socket.open();
  await connecting;
  assert.equal(events.states.at(-1).state, 'connected');
  const first = socket.sent[0];
  assert.equal(typeof first, 'string');
  assert.match(first, /^path:speech\.config/);
  assert.match(first, /x-requestid:[0-9a-f]{32}/);
  assert.match(first, /"phrases":\["Volyx Lens"\]/);
  assert.doesNotMatch(first, /speech-secret-key/);
});

test('audio is framed with a big-endian header length and L16 content type before the PCM', async () => {
  const { channel } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;

  const pcm = Buffer.alloc(480 * 2, 9);
  assert.equal(channel.append(pcm), true);
  const frame = socket.sent[1];
  assert.ok(Buffer.isBuffer(frame));
  const headerLength = frame.readUInt16BE(0);
  const header = frame.slice(2, 2 + headerLength).toString('ascii');
  assert.match(header, /^path:audio/);
  assert.match(header, /content-type:audio\/L16; rate=24000/);
  assert.deepEqual(frame.slice(2 + headerLength), pcm);
});

test('hypothesis and phrase messages map to partial and final events', async () => {
  const { channel, events } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;
  socket.sent.length = 0;

  const hypothesis = [
    'path:speech.hypothesis',
    'x-requestid:abc',
    'x-timestamp:2026-01-01T00:00:00.000Z',
    'content-type:application/json; charset=utf-8',
    '',
    '',
    '{"Text":"hello wor"}',
  ].join('\r\n');
  socket.emit('message', hypothesis);
  assert.equal(events.partial.length, 1);
  assert.equal(events.partial[0].channel, 'them');
  assert.equal(events.partial[0].text, 'hello wor');
  assert.match(events.partial[0].itemId, /^azure-speech-them-partial-1$/);

  const phrase = [
    'path:speech.phrase',
    'x-requestid:def',
    'x-timestamp:2026-01-01T00:00:01.000Z',
    'content-type:application/json; charset=utf-8',
    '',
    '',
    '{"RecognitionStatus":"Success","DisplayText":"hello world."}',
  ].join('\r\n');
  socket.emit('message', phrase);
  assert.equal(events.final.length, 1);
  assert.equal(events.final[0].channel, 'them');
  assert.equal(events.final[0].text, 'hello world.');
  assert.match(events.final[0].itemId, /^azure-speech-them-1$/);
  assert.ok(events.latency.length >= 1);
  assert.equal(events.latency[0].kind, 'final');
});

test('non-success phrase results are ignored without emitting a final', async () => {
  const { channel, events } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;

  const phrase = [
    'path:speech.phrase',
    'x-requestid:abc',
    'x-timestamp:2026-01-01T00:00:00.000Z',
    '',
    '',
    '{"RecognitionStatus":"NoMatch","DisplayText":""}',
  ].join('\r\n');
  socket.emit('message', phrase);
  assert.equal(events.final.length, 0);
});

test('duplicate phrase item ids are deduplicated', async () => {
  const { channel, events } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;

  const phrase = (timestamp) => [
    'path:speech.phrase',
    'x-requestid:abc',
    `x-timestamp:${timestamp}`,
    '',
    '',
    '{"RecognitionStatus":"Success","DisplayText":"hello"}',
  ].join('\r\n');
  socket.emit('message', phrase('2026-01-01T00:00:00.000Z'));
  socket.emit('message', phrase('2026-01-01T00:00:01.000Z'));
  assert.equal(events.final.length, 1);
});

test('audio is queued before open, bounded, then flushed after connection', async () => {
  const failures = [];
  const { channel } = buildChannel({ maxQueuedBytes: 8 });
  channel.onError = (error) => failures.push(error);
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];

  assert.equal(channel.append(Buffer.from([1, 2, 3, 4, 5, 6])), true);
  assert.equal(channel.append(Buffer.from([7, 8, 9, 10, 11, 12])), false);
  assert.equal(failures[0].code, 'realtime_transport_failed');
  socket.open();
  await connecting;
  const frames = socket.sent.filter(Buffer.isBuffer);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].readUInt16BE(0) > 0, true);
});

test('unexpected post-open closure reports one transport failure, intentional close reports none', async () => {
  const unexpectedFailures = [];
  const unexpected = new AzureSpeechRealtimeChannel({
    apiKey: 'speech-secret', channel: 'them', region: 'eastus', WebSocketImpl: FakeWebSocket,
    onError: (error) => unexpectedFailures.push(error),
  });
  const unexpectedConnecting = unexpected.connect();
  FakeWebSocket.instances[0].open();
  await unexpectedConnecting;
  FakeWebSocket.instances[0].remoteClose(1006, 'network lost');
  assert.equal(unexpectedFailures.length, 1);
  assert.equal(unexpectedFailures[0].code, 'realtime_transport_failed');

  const intentionalFailures = [];
  const intentional = new AzureSpeechRealtimeChannel({
    apiKey: 'speech-secret', channel: 'you', region: 'eastus', WebSocketImpl: FakeWebSocket,
    onError: (error) => intentionalFailures.push(error),
  });
  const intentionalConnecting = intentional.connect();
  FakeWebSocket.instances[1].open();
  await intentionalConnecting;
  intentional.close();
  assert.equal(intentionalFailures.length, 0);
});

test('channel fails closed on socket backpressure', async () => {
  const failures = [];
  const { channel } = buildChannel({ maxBufferedBytes: 100 });
  channel.onError = (error) => failures.push(error);
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;
  socket.sent.length = 0;
  socket.bufferedAmount = 90;
  assert.equal(channel.append(Buffer.alloc(20)), false);
  assert.equal(failures[0].code, 'realtime_transport_failed');
});

test('error messages are sanitized and never include the API key', async () => {
  const failures = [];
  const channel = new AzureSpeechRealtimeChannel({
    apiKey: 'speech-secret-value',
    channel: 'them',
    region: 'eastus',
    WebSocketImpl: FakeWebSocket,
    onError: (error) => failures.push(error),
  });
  const connecting = channel.connect();
  FakeWebSocket.instances[0].open();
  await connecting;
  FakeWebSocket.instances[0].emit('error', new Error('401 speech-secret-value invalid key'));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'realtime_authentication_failed');
  assert.doesNotMatch(JSON.stringify(failures[0]), /speech-secret-value/);
});

test('manager streams continuous Azure Speech audio without a local commit', async () => {
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'speech-secret',
    provider: 'azureSpeech',
    region: 'eastus',
    phrases: ['Volyx Lens'],
    enabledChannels: ['you', 'them'],
    WebSocketImpl: FakeWebSocket,
  });
  const connecting = manager.start();
  assert.equal(FakeWebSocket.instances.length, 2);
  FakeWebSocket.instances.forEach((socket) => socket.open());
  await connecting;
  const quietChunk = Buffer.alloc(480 * 2);
  assert.equal(manager.append('you', quietChunk), true);
  assert.equal(manager.append('them', quietChunk), true);
  const frames = FakeWebSocket.instances.map((socket) => socket.sent.filter(Buffer.isBuffer).length);
  assert.equal(frames[0], 1);
  assert.equal(frames[1], 1);
  await manager.stop();
});