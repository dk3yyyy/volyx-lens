const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { OpenAIRealtimeChannel, RealtimeTranscriptionManager } = require('../src/realtime-stt');

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

  send(payload) { this.sent.push(JSON.parse(payload)); }
  close() { this.readyState = 3; this.emit('close', 1000, Buffer.from('closed')); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close', 1006, Buffer.from('terminated')); }
  remoteClose(code = 1000, reason = 'remote close') { this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
}

function buildChannel(overrides = {}) {
  const events = { partial: [], final: [], errors: [], itemFailures: [] };
  const channel = new OpenAIRealtimeChannel({
    apiKey: 'test-secret-key',
    channel: 'them',
    model: 'gpt-realtime-whisper',
    language: 'en',
    delay: 'low',
    sampleRate: 24000,
    WebSocketImpl: FakeWebSocket,
    onPartial: (event) => events.partial.push(event),
    onFinal: (event) => events.final.push(event),
    onError: (error) => events.errors.push(error),
    onItemFailure: (failure) => events.itemFailures.push(failure),
    ...overrides,
  });
  return { channel, events };
}

test.beforeEach(() => { FakeWebSocket.instances = []; });

test('realtime channel authenticates in headers and configures a transcription session', async () => {
  const { channel } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];

  assert.match(socket.url, /^wss:\/\/api\.openai\.com\/v1\/realtime\?model=gpt-realtime-whisper$/);
  assert.doesNotMatch(socket.url, /test-secret-key/);
  assert.equal(socket.options.headers.Authorization, 'Bearer test-secret-key');
  socket.open();
  await connecting;

  assert.deepEqual(socket.sent[0], {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'gpt-realtime-whisper', language: 'en', delay: 'low' },
          turn_detection: null,
        },
      },
    },
  });
});

test('Azure realtime channel uses the GA transcription endpoint and api-key header', async () => {
  const { channel } = buildChannel({
    provider: 'azure',
    endpoint: 'https://demo.services.ai.azure.com/api/projects/volyx-lens/openai/v1',
    model: 'volyx-lens-whisper-deployment',
    language: 'auto',
  });
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];

  assert.equal(socket.url, 'wss://demo.services.ai.azure.com/openai/v1/realtime?intent=transcription');
  assert.equal(socket.options.headers['api-key'], 'test-secret-key');
  assert.equal('Authorization' in socket.options.headers, false);
  assert.doesNotMatch(socket.url, /test-secret-key/);

  socket.open();
  await connecting;
  assert.equal(socket.sent[0].session.audio.input.transcription.model, 'volyx-lens-whisper-deployment');
  assert.equal('language' in socket.sent[0].session.audio.input.transcription, false);
});

test('Azure realtime rejects non-Azure endpoints before opening a socket', () => {
  const { channel } = buildChannel({
    provider: 'azure',
    endpoint: 'https://evil.example/openai/v1',
    model: 'volyx-lens-whisper-deployment',
  });
  assert.throws(() => channel.connect(), /official resource or project-scoped HTTPS/);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('audio is queued before open, bounded, then committed after connection', async () => {
  const { channel } = buildChannel({ maxQueuedBytes: 8 });
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];

  channel.append(Buffer.from([1, 2, 3, 4, 5, 6]));
  channel.append(Buffer.from([7, 8, 9, 10, 11, 12]));
  channel.commit();
  socket.open();
  await connecting;

  const append = socket.sent.find((event) => event.type === 'input_audio_buffer.append');
  assert.equal(Buffer.from(append.audio, 'base64').length <= 8, true);
  assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.commit');
});

test('partial deltas are accumulated and finals are deduplicated by item id', async () => {
  const { channel, events } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'Hello' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: ' world' })));
  const completed = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Hello world' };
  socket.emit('message', Buffer.from(JSON.stringify(completed)));
  socket.emit('message', Buffer.from(JSON.stringify(completed)));

  assert.deepEqual(events.partial.map((event) => event.text), ['Hello', 'Hello world']);
  assert.equal(events.final.length, 1);
  assert.equal(events.final[0].channel, 'them');
  assert.equal(events.final[0].itemId, 'a');
  assert.equal(events.final[0].text, 'Hello world');
  assert.equal(Number.isFinite(events.final[0].ts), true);
});

test('API error events are sanitized and reported without leaking the key', async () => {
  const { channel, events } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'error', error: { code: 'invalid_api_key', message: 'bad key' } })));
  assert.equal(events.errors.length, 1);
  assert.deepEqual(events.errors[0], { code: 'realtime_authentication_failed', message: 'Realtime transcription authentication failed.', channel: 'them' });
  assert.doesNotMatch(JSON.stringify(events.errors), /test-secret-key/);
});

test('realtime errors without a code are classified from type and message fields', async () => {
  const { channel, events } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'API key rejected' } })));
  assert.deepEqual(events.errors[0], { code: 'realtime_authentication_failed', message: 'Realtime transcription authentication failed.', channel: 'them' });
});

test('item-level transcription failures are nonfatal so later audio can continue', async () => {
  const { channel, events } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: 'silent-item',
    error: { code: 'audio_invalid', message: 'Audio could not be processed.' },
  })));
  assert.deepEqual(events.itemFailures[0], {
    code: 'realtime_audio_failed', message: 'Realtime transcription could not process this audio segment.', channel: 'them', itemId: 'silent-item',
  });
  assert.equal(events.errors.length, 0);
  assert.equal(socket.readyState, FakeWebSocket.OPEN);

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'later-item',
    transcript: 'Later speech still works.',
  })));
  assert.equal(events.final[0].text, 'Later speech still works.');
});

test('closing while connecting terminates the socket and settles the connection promise', async () => {
  const { channel } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  channel.close();

  assert.equal(socket.terminated, true);
  await assert.rejects(connecting, /stopped/i);
});

test('socket backpressure is bounded and fails closed', async () => {
  const { channel, events } = buildChannel({ maxBufferedBytes: 8 });
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;
  socket.bufferedAmount = 8;

  channel.append(Buffer.from([1, 2]));
  assert.equal(events.errors[0].code, 'realtime_transport_failed');
  assert.equal(socket.sent.some((event) => event.type === 'input_audio_buffer.append'), false);
});

test('connection timeout rejects and closes a socket that never opens', async () => {
  const { channel, events } = buildChannel({ connectTimeoutMs: 5 });
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];

  await assert.rejects(connecting, /timed out/i);
  assert.equal(socket.terminated, true);
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, 'realtime_connection_timeout');
});

test('unexpected normal socket closure triggers fallback error handling', async () => {
  const { channel, events } = buildChannel();
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;

  socket.remoteClose(1000);
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, 'realtime_transport_failed');
});

test('manager opens only enabled audio channels and reports the correct total', async () => {
  const states = [];
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'test-' + 'key',
    sampleRate: 1000,
    enabledChannels: ['you'],
    WebSocketImpl: FakeWebSocket,
    onState: (event) => states.push(event),
  });
  const starting = manager.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  FakeWebSocket.instances[0].open();
  await starting;
  const channelState = states.find((event) => event.status === 'channel' && event.channelState === 'connected');
  assert.equal(channelState.totalChannels, 1);
  assert.deepEqual(Object.keys(manager.channels), ['you']);
});

test('Azure manager streams continuously and commits documented fixed audio windows', async () => {
  const states = [];
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'test-' + 'key',
    provider: 'azure',
    endpoint: 'https://demo.services.ai.azure.com/openai/v1',
    model: 'volyx-lens-whisper-deployment',
    sampleRate: 1000,
    azureCommitMs: 1000,
    vad: { threshold: 500 },
    WebSocketImpl: FakeWebSocket,
    onState: (event) => states.push(event),
  });
  const starting = manager.start();
  FakeWebSocket.instances.forEach((socket) => socket.open());
  await starting;

  const chunk = Buffer.from(new Int16Array(100).fill(300).buffer);
  for (let index = 0; index < 9; index += 1) manager.append('you', chunk);
  const sent = manager.channels.you.socket.sent;
  assert.equal(sent.filter((event) => event.type === 'input_audio_buffer.append').length, 9);
  assert.equal(sent.some((event) => event.type === 'input_audio_buffer.commit'), false);

  manager.append('you', chunk);
  assert.equal(sent.filter((event) => event.type === 'input_audio_buffer.append').length, 10);
  assert.equal(sent.filter((event) => event.type === 'input_audio_buffer.commit').length, 1);
  assert.equal(states.some((event) => event.status === 'activity' && event.fixedWindow), true);
});

test('manager keeps speaker channels separate and commits on local silence', async () => {
  const finals = [];
  const states = [];
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'test-secret-key',
    sampleRate: 24000,
    vad: { threshold: 500, silenceMs: 300 },
    WebSocketImpl: FakeWebSocket,
    onFinal: (event) => finals.push(event),
    onState: (event) => states.push(event),
  });
  const starting = manager.start();
  FakeWebSocket.instances.forEach((socket) => socket.open());
  await starting;

  const loud = Buffer.from(new Int16Array(4096).fill(1200).buffer);
  const quiet = Buffer.alloc(4096 * 2);
  manager.append('them', loud);
  manager.append('them', quiet);
  manager.append('them', quiet);

  const themSocket = FakeWebSocket.instances.find((socket) => socket.sent[0].session.audio.input.transcription.model === 'gpt-realtime-whisper' && socket === manager.channels.them.socket);
  assert.equal(themSocket.sent.some((event) => event.type === 'input_audio_buffer.append'), true);
  assert.equal(themSocket.sent.some((event) => event.type === 'input_audio_buffer.commit'), true);
  themSocket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'them-1',
    transcript: 'What experience do you have?',
  })));
  assert.equal(finals[0].channel, 'them');
  assert.equal(finals[0].itemId, 'them-1');
  assert.equal(finals[0].text, 'What experience do you have?');
  assert.equal(Number.isFinite(finals[0].ts), true);
  assert.equal(states.some((event) => event.status === 'connected'), true);
  assert.deepEqual(states.at(-1), { mode: 'realtime', status: 'activity', channel: 'them', activity: 'processing' });
});

test('manager fails once instead of reconnecting or duplicating error events', async () => {
  const errors = [];
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'test-secret-key',
    WebSocketImpl: FakeWebSocket,
    onError: (error) => errors.push(error),
  });
  const starting = manager.start();
  FakeWebSocket.instances.forEach((socket) => socket.open());
  await starting;

  const failure = Buffer.from(JSON.stringify({ type: 'error', error: { code: 'rate_limit', message: 'slow down' } }));
  FakeWebSocket.instances[0].emit('message', failure);
  FakeWebSocket.instances[1].emit('message', failure);
  assert.equal(errors.length, 1);
  assert.equal(manager.failed, true);
});

test('manager keeps both realtime channels alive after a silent item failure', async () => {
  const states = [];
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'test-' + 'key',
    WebSocketImpl: FakeWebSocket,
    onState: (event) => states.push(event),
  });
  const starting = manager.start();
  FakeWebSocket.instances.forEach((socket) => socket.open());
  await starting;

  manager.channels.them.socket.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: 'silence',
    error: { code: 'transcription_failed', message: 'Input transcription failed.' },
  })));

  assert.equal(manager.failed, false);
  assert.equal(Object.values(manager.channels).every((channel) => channel.socket.readyState === FakeWebSocket.OPEN), true);
  assert.equal(states.some((event) => event.status === 'item_failed' && event.channel === 'them'), true);
});

test('manager graceful stop resolves after channels close', async () => {
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'test-...ey',
    WebSocketImpl: FakeWebSocket,
  });
  const starting = manager.start();
  FakeWebSocket.instances.forEach((socket) => socket.open());
  await starting;

  const stopping = manager.stop({ graceMs: 5 });
  assert.equal(manager.closed, false);
  await stopping;
  assert.equal(manager.closed, true);
  assert.equal(FakeWebSocket.instances.every((socket) => socket.readyState === 3), true);
});

test('manager includes bounded audio preroll when speech begins', async () => {
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'test-...ey',
    sampleRate: 1000,
    preRollMs: 100,
    vad: { threshold: 500, silenceMs: 100 },
    WebSocketImpl: FakeWebSocket,
  });
  const starting = manager.start();
  FakeWebSocket.instances.forEach((socket) => socket.open());
  await starting;

  const quiet = Buffer.alloc(100);
  const loud = Buffer.from(new Int16Array(50).fill(1200).buffer);
  manager.append('you', quiet);
  manager.append('you', quiet);
  manager.append('you', loud);
  manager.append('you', loud);
  const append = manager.channels.you.socket.sent.find((event) => event.type === 'input_audio_buffer.append');
  assert.equal(Buffer.from(append.audio, 'base64').length, 200);
});

test('manager fallback-commits audible audio that stays below the primary VAD threshold', async () => {
  const states = [];
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'test-' + 'key',
    sampleRate: 1000,
    fallbackCommitMs: 1000,
    fallbackThresholdRatio: 0.45,
    vad: { threshold: 500, silenceMs: 100 },
    WebSocketImpl: FakeWebSocket,
    onState: (event) => states.push(event),
  });
  const starting = manager.start();
  FakeWebSocket.instances.forEach((socket) => socket.open());
  await starting;

  const quietSpeech = Buffer.from(new Int16Array(100).fill(300).buffer);
  for (let index = 0; index < 10; index += 1) manager.append('you', quietSpeech);

  const sent = manager.channels.you.socket.sent;
  assert.equal(sent.some((event) => event.type === 'input_audio_buffer.append'), true);
  assert.equal(sent.some((event) => event.type === 'input_audio_buffer.commit'), true);
  assert.equal(states.some((event) => event.status === 'activity' && event.activity === 'processing' && event.fallback), true);
});

test('graceful stop flushes eligible quiet speech before clearing the fallback buffer', async () => {
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'test-' + 'key',
    sampleRate: 1000,
    fallbackCommitMs: 1000,
    fallbackThresholdRatio: 0.45,
    vad: { threshold: 500, silenceMs: 100 },
    WebSocketImpl: FakeWebSocket,
  });
  const starting = manager.start();
  FakeWebSocket.instances.forEach((socket) => socket.open());
  await starting;

  const quietSpeech = Buffer.from(new Int16Array(100).fill(300).buffer);
  for (let index = 0; index < 5; index += 1) manager.append('you', quietSpeech);
  const sent = manager.channels.you.socket.sent;
  assert.equal(sent.some((event) => event.type === 'input_audio_buffer.commit'), false);

  await manager.stop({ graceMs: 5 });
  assert.equal(sent.some((event) => event.type === 'input_audio_buffer.append'), true);
  assert.equal(sent.some((event) => event.type === 'input_audio_buffer.commit'), true);
});

test('channel reports connection health and transcript latency', async () => {
  const states = [];
  const latencies = [];
  const { channel } = buildChannel({ onState: (event) => states.push(event), onLatency: (event) => latencies.push(event) });
  const connecting = channel.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;
  channel.append(Buffer.alloc(100));
  channel.commit();
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'latency-1' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'latency-1', delta: 'hello' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'latency-1', transcript: 'hello' })));
  assert.deepEqual(states.slice(0, 2).map((event) => event.state), ['connecting', 'connected']);
  assert.deepEqual(latencies.map((event) => event.kind), ['first_partial', 'final']);
  assert.equal(latencies.every((event) => event.latencyMs >= 0), true);
});
