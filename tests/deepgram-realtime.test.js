'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DeepgramRealtimeChannel, buildDeepgramOptions } = require('../src/deepgram-realtime');
const { RealtimeTranscriptionManager } = require('../src/realtime-stt');
const { runRealtimeDiagnostic } = require('../src/realtime-diagnostic');
const { resolveRealtimeTranscription, getDefaultSettings } = require('../src/provider-config');

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.socket = { readyState: 1, bufferedAmount: 0 };
    this.media = [];
    this.keepAlives = 0;
    this.finalized = 0;
    this.closeStreams = 0;
    this.closed = 0;
  }
  connect() { queueMicrotask(() => this.emit('open')); }
  async waitForOpen() {}
  sendMedia(buffer) { this.media.push(Buffer.from(buffer)); }
  sendKeepAlive() { this.keepAlives += 1; }
  sendFinalize() { this.finalized += 1; }
  sendCloseStream() { this.closeStreams += 1; }
  close() { this.closed += 1; this.socket.readyState = 3; this.emit('close', 1000, 'closed'); }
}

class FakeDeepgramClient {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.connection = new FakeConnection();
    this.listen = { v1: { connect: async (query) => {
      this.query = query;
      return this.connection;
    } } };
    FakeDeepgramClient.instances.push(this);
  }
}

class DelayedConnection extends FakeConnection {
  constructor() {
    super();
    this.connectCalls = 0;
    this.openPromise = new Promise((resolve) => { this.resolveOpen = resolve; });
  }
  connect() { this.connectCalls += 1; }
  waitForOpen() { return this.openPromise; }
  open() { this.emit('open'); this.resolveOpen(); }
}

class DelayedDeepgramClient {
  static connection = null;
  static resolveFactory = null;
  constructor() {
    this.listen = { v1: { connect: () => new Promise((resolve) => {
      DelayedDeepgramClient.resolveFactory = () => {
        DelayedDeepgramClient.connection = new DelayedConnection();
        resolve(DelayedDeepgramClient.connection);
      };
    }) } };
  }
}

class PreOpenFailureClient {
  static connection = null;
  constructor() {
    PreOpenFailureClient.connection = new DelayedConnection();
    this.listen = { v1: { connect: async () => PreOpenFailureClient.connection } };
  }
}

class ThrowingClient {
  constructor() { throw new Error('client construction failed'); }
}

class NeverConnectingClient {
  constructor() {
    this.listen = { v1: { connect: () => new Promise(() => {}) } };
  }
}

test.beforeEach(() => {
  FakeDeepgramClient.instances = [];
  DelayedDeepgramClient.connection = null;
  DelayedDeepgramClient.resolveFactory = null;
  PreOpenFailureClient.connection = null;
});

async function settlesWithin(promise, timeoutMs = 100) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve('still-pending'), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('Deepgram options use Nova-3 with continuous 24 kHz linear PCM and bounded endpointing', () => {
  assert.deepEqual(buildDeepgramOptions({ model: 'nova-3', language: 'en', sampleRate: 24000 }), {
    model: 'nova-3',
    language: 'en',
    encoding: 'linear16',
    sample_rate: '24000',
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
    reconnectAttempts: 0,
  });
  assert.equal('language' in buildDeepgramOptions({ model: 'nova-3', language: '', sampleRate: 24000 }), false);
});

test('provider configuration resolves a saved Deepgram key and pinned model without exposing an endpoint', () => {
  const settings = getDefaultSettings();
  settings.transcription.realtimeProvider = 'deepgram';
  settings.transcription.deepgramModel = 'nova-3';
  settings.apiKeys.deepgram = 'deepgram-secret';
  const resolved = resolveRealtimeTranscription(settings);
  assert.equal(resolved.ready, true);
  assert.equal(resolved.provider, 'deepgram');
  assert.equal(resolved.label, 'Deepgram');
  assert.equal(resolved.model, 'nova-3');
  assert.equal(resolved.apiKey, 'deepgram-secret');
  assert.equal(resolved.endpoint, null);
});

test('Deepgram channel streams binary PCM continuously and maps interim and final results', async () => {
  const partials = [];
  const finals = [];
  const states = [];
  const latency = [];
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret',
    channel: 'you',
    model: 'nova-3',
    language: 'en',
    sampleRate: 24000,
    drainTimeoutMs: 10,
    DeepgramClientImpl: FakeDeepgramClient,
    onPartial: (event) => partials.push(event),
    onFinal: (event) => finals.push(event),
    onState: (event) => states.push(event),
    onLatency: (event) => latency.push(event),
  });

  await channel.connect();
  const client = FakeDeepgramClient.instances[0];
  assert.equal(client.options.apiKey, 'deepgram-secret');
  assert.equal(client.options.reconnect, false);
  assert.equal(client.query.model, 'nova-3');
  assert.equal(states.at(-1).state, 'connected');

  const pcm = Buffer.alloc(480 * 2, 7);
  assert.equal(channel.append(pcm), true);
  assert.deepEqual(client.connection.media[0], pcm);

  client.connection.emit('message', {
    type: 'Results', start: 0, duration: 0.8, is_final: false,
    channel: { alternatives: [{ transcript: 'hello wor' }] },
  });
  client.connection.emit('message', {
    type: 'Results', start: 0, duration: 1.1, is_final: true, speech_final: true,
    channel: { alternatives: [{ transcript: 'hello world' }] },
  });

  assert.equal(partials.length, 1);
  assert.equal(partials[0].channel, 'you');
  assert.equal(partials[0].text, 'hello wor');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'hello world');
  assert.match(finals[0].itemId, /^deepgram-you-/);
  assert.ok(latency.length >= 1);

  channel.commit();
  assert.equal(client.connection.finalized, 1);
  await channel.close();
  assert.equal(client.connection.closeStreams, 1);
  assert.equal(client.connection.closed, 1);
});

test('Deepgram channel sanitizes failures and never includes the API key', async () => {
  const failures = [];
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret-value',
    channel: 'them',
    drainTimeoutMs: 10,
    DeepgramClientImpl: FakeDeepgramClient,
    onError: (error) => failures.push(error),
  });
  await channel.connect();
  FakeDeepgramClient.instances[0].connection.emit('error', new Error('401 deepgram-secret-value invalid token'));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'realtime_authentication_failed');
  assert.doesNotMatch(JSON.stringify(failures[0]), /deepgram-secret-value/);
  await channel.close();
});

test('unexpected post-open Deepgram closure reports one transport failure, intentional close reports none', async () => {
  const unexpectedFailures = [];
  const unexpected = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret', channel: 'them', drainTimeoutMs: 10, DeepgramClientImpl: FakeDeepgramClient,
    onError: (error) => unexpectedFailures.push(error),
  });
  await unexpected.connect();
  FakeDeepgramClient.instances[0].connection.emit('close', 1000, 'server closed');
  assert.equal(unexpectedFailures.length, 1);
  assert.equal(unexpectedFailures[0].code, 'realtime_transport_failed');

  const intentionalFailures = [];
  const intentional = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret', channel: 'you', drainTimeoutMs: 10, DeepgramClientImpl: FakeDeepgramClient,
    onError: (error) => intentionalFailures.push(error),
  });
  await intentional.connect();
  await intentional.close();
  assert.equal(intentionalFailures.length, 0);
});

test('Deepgram channel fails closed on SDK socket backpressure', async () => {
  const failures = [];
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret', channel: 'you', maxBufferedBytes: 100,
    drainTimeoutMs: 10,
    DeepgramClientImpl: FakeDeepgramClient,
    onError: (error) => failures.push(error),
  });
  await channel.connect();
  FakeDeepgramClient.instances[0].connection.socket.bufferedAmount = 90;
  assert.equal(channel.append(Buffer.alloc(20)), false);
  assert.equal(failures[0].code, 'realtime_transport_failed');
  await channel.close();
});

test('Deepgram channel queues bounded PCM until the socket is open', async () => {
  const failures = [];
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret', channel: 'you', maxBufferedBytes: 100,
    drainTimeoutMs: 10,
    DeepgramClientImpl: DelayedDeepgramClient,
    onError: (error) => failures.push(error),
  });
  const connecting = channel.connect();
  await new Promise((resolve) => setImmediate(resolve));
  DelayedDeepgramClient.resolveFactory();
  await new Promise((resolve) => setImmediate(resolve));
  const connection = DelayedDeepgramClient.connection;
  assert.equal(channel.append(Buffer.alloc(60, 1)), true);
  assert.equal(connection.media.length, 0);
  assert.equal(channel.append(Buffer.alloc(50, 2)), false);
  assert.equal(failures[0].code, 'realtime_transport_failed');
  connection.open();
  await connecting;
  assert.deepEqual(connection.media, [Buffer.alloc(60, 1)]);
  await channel.close();
});

test('closing during asynchronous SDK connection creation cannot open a leaked socket', async () => {
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret', channel: 'you',
    DeepgramClientImpl: DelayedDeepgramClient,
  });
  const connecting = channel.connect();
  await new Promise((resolve) => setImmediate(resolve));
  const closing = channel.close();
  DelayedDeepgramClient.resolveFactory();
  await assert.rejects(connecting, /cancelled/i);
  await closing;
  assert.equal(DelayedDeepgramClient.connection.connectCalls, 0);
  assert.equal(DelayedDeepgramClient.connection.closed, 1);
});

for (const eventName of ['error', 'close']) {
  test(`Deepgram ${eventName} before open rejects immediately instead of waiting for timeout`, async () => {
    const failures = [];
    const channel = new DeepgramRealtimeChannel({
      apiKey: 'deepgram-secret', channel: 'you', connectTimeoutMs: 5000,
      DeepgramClientImpl: PreOpenFailureClient,
      onError: (error) => failures.push(error),
    });
    const connecting = channel.connect();
    await new Promise((resolve) => setImmediate(resolve));
    const connection = PreOpenFailureClient.connection;
    if (eventName === 'error') connection.emit('error', new Error('socket failed before open'));
    else connection.emit('close', 1006, 'network lost');
    const outcome = await settlesWithin(connecting.then(() => 'resolved', () => 'rejected'));
    assert.equal(outcome, 'rejected');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'realtime_transport_failed');
    assert.equal(channel.connection, null, 'the dead connection is not retained');
    assert.equal(channel.append(Buffer.alloc(2)), false, 'append rejects a dead channel');
  });
}

test('Deepgram pre-open error stays a transport failure when the error callback closes the channel', async () => {
  const failures = [];
  let channel = null;
  channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret', channel: 'you', connectTimeoutMs: 5000,
    DeepgramClientImpl: PreOpenFailureClient,
    onError: (error) => { failures.push(error); channel.close(); },
  });
  const connecting = channel.connect();
  await new Promise((resolve) => setImmediate(resolve));
  const connection = PreOpenFailureClient.connection;
  connection.emit('error', new Error('socket failed before open'));
  connection.emit('close', 1006, 'network lost');
  await assert.rejects(connecting, /Deepgram transcription connection failed/i);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'realtime_transport_failed');
  assert.equal(connection.closed, 1);
});

test('manager sends continuous Deepgram audio without waiting for a local VAD commit', async () => {
  const manager = new RealtimeTranscriptionManager({
    apiKey: 'deepgram-secret',
    provider: 'deepgram',
    model: 'nova-3',
    enabledChannels: ['you', 'them'],
    DeepgramClientImpl: FakeDeepgramClient,
  });
  await manager.start();
  const quietChunk = Buffer.alloc(480 * 2);
  assert.equal(manager.append('you', quietChunk), true);
  assert.equal(manager.append('them', quietChunk), true);
  assert.equal(FakeDeepgramClient.instances.length, 2);
  assert.equal(FakeDeepgramClient.instances[0].connection.media.length, 1);
  assert.equal(FakeDeepgramClient.instances[1].connection.media.length, 1);
  await manager.stop();
});

test('connection diagnostic verifies Deepgram without sending audio or exposing the key', async () => {
  const settings = getDefaultSettings();
  settings.transcription.realtimeProvider = 'deepgram';
  settings.transcription.deepgramModel = 'nova-3';
  settings.apiKeys.deepgram = 'deepgram-secret';
  const result = await runRealtimeDiagnostic({ settings, DeepgramClientImpl: FakeDeepgramClient });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'deepgram');
  assert.equal(result.deployment, 'nova-3');
  assert.equal(FakeDeepgramClient.instances[0].connection.media.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /deepgram-secret/);
});

test('keyterm prompting is only sent to the models that support it', () => {
  const supported = buildDeepgramOptions({ model: 'nova-3', sampleRate: 24000, keyterms: ['Volyx', 'DeepSeek'] });
  assert.deepEqual(supported.keyterm, ['Volyx', 'DeepSeek']);

  const legacy = buildDeepgramOptions({ model: 'nova-2', sampleRate: 24000, keyterms: ['Volyx'] });
  assert.equal('keyterm' in legacy, false, 'older models reject the parameter');

  const empty = buildDeepgramOptions({ model: 'nova-3', sampleRate: 24000, keyterms: [] });
  assert.equal('keyterm' in empty, false);

  const blank = buildDeepgramOptions({ model: 'nova-3', sampleRate: 24000, keyterms: ['  ', ''] });
  assert.equal('keyterm' in blank, false, 'blank terms are not sent');
});

async function connectedDeepgramChannel(overrides = {}) {
  const finals = [];
  const partials = [];
  const errors = [];
  const states = [];
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret',
    channel: 'you',
    model: 'nova-3',
    language: 'en',
    sampleRate: 24000,
    drainTimeoutMs: 20,
    DeepgramClientImpl: FakeDeepgramClient,
    onFinal: (event) => finals.push(event),
    onPartial: (event) => partials.push(event),
    onError: (error) => errors.push(error),
    onState: (event) => states.push(event),
    ...overrides,
  });
  await channel.connect();
  const connection = FakeDeepgramClient.instances.at(-1).connection;
  return { channel, connection, finals, partials, errors, states };
}

function results(connection, {
  transcript = '',
  start = 0,
  duration = 0.5,
  isFinal = false,
  speechFinal = false,
  fromFinalize = false,
} = {}) {
  connection.emit('message', {
    type: 'Results',
    start,
    duration,
    is_final: isFinal,
    speech_final: speechFinal,
    from_finalize: fromFinalize,
    channel: { alternatives: [{ transcript }] },
  });
}

test('Deepgram close sends CloseStream and waits for the drain before closing the SDK socket', async () => {
  const { channel, connection } = await connectedDeepgramChannel({ drainTimeoutMs: 1000 });
  const closing = channel.close();
  let resolved = false;
  closing.then(() => { resolved = true; });

  assert.equal(connection.closeStreams, 1, 'CloseStream is sent first');
  assert.equal(connection.closed, 0, 'the socket stays open for the drain');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, 'close does not resolve before a final or Metadata');
  assert.equal(connection.closed, 0, 'the SDK close is not called before the drain');

  connection.emit('message', { type: 'Metadata' });
  await closing;
  assert.equal(connection.closed, 1, 'the socket is closed only after the drain');
});

test('a final arriving after close() starts is still emitted', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel({ drainTimeoutMs: 1000 });
  const closing = channel.close();
  let resolved = false;
  closing.then(() => { resolved = true; });

  results(connection, { transcript: 'last words', isFinal: true, fromFinalize: true, duration: 1.2 });
  await closing;

  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'last words');
  assert.equal(resolved, true);
  assert.equal(connection.closed, 1);
});

test('from_finalize without speech_final closes the utterance boundary', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel();
  results(connection, { transcript: 'pending part', isFinal: true });
  assert.equal(channel.committed, 'pending part');

  results(connection, { transcript: 'tail', isFinal: true, fromFinalize: true, duration: 1 });
  assert.equal(channel.committed, '');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'pending part tail');
  await channel.close();
});

test('close() flushes committed text when no final arrives during the drain', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  results(connection, { transcript: 'pending tail', isFinal: true });
  assert.equal(finals.length, 0);

  await channel.close();
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'pending tail');
  assert.equal(channel.committed, '');
  assert.equal(connection.closed, 1);
});

test('an empty speech_final ends the utterance without merging the next one', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  results(connection, { transcript: 'first utterance', isFinal: true });
  results(connection, { transcript: '', isFinal: true, speechFinal: true, duration: 1 });
  assert.deepEqual(finals.map((event) => event.text), ['first utterance']);

  results(connection, { transcript: 'second utterance', isFinal: true });
  await channel.close();
  assert.deepEqual(finals.map((event) => event.text), ['first utterance', 'second utterance']);
});

test('in-band Error and ConfigureFailure frames are reported once and never leak the key', async () => {
  const { channel, connection, errors } = await connectedDeepgramChannel();
  connection.emit('message', { type: 'Error', code: 'UNAUTHORIZED', message: '401 deepgram-secret invalid token' });
  connection.emit('message', { type: 'ConfigureFailure', message: 'unsupported model for deepgram-secret' });
  assert.equal(errors.length, 1, 'a channel reports a single failure');
  assert.doesNotMatch(JSON.stringify(errors[0]), /deepgram-secret/);
  assert.equal(channel.opened, true, 'an in-band server error does not crash or close the channel');
  await channel.close();
});

test('UtteranceEnd with last_word_end -1 does not flush', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  results(connection, { transcript: 'kept for now', isFinal: true });

  connection.emit('message', { type: 'UtteranceEnd', last_word_end: -1 });
  assert.equal(finals.length, 0);

  connection.emit('message', { type: 'UtteranceEnd', last_word_end: 0.8 });
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'kept for now');
  await channel.close();
});

test('a duplicate final frame emits a single final', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  const frame = {
    type: 'Results', start: 0.4, duration: 0.9, is_final: true, speech_final: true,
    channel: { alternatives: [{ transcript: 'hello world' }] },
  };
  connection.emit('message', frame);
  connection.emit('message', { ...frame });
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'hello world');
  await channel.close();
});

test('every emitted partial and final has a unique monotonic itemId', async () => {
  const { channel, connection, finals, partials } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  results(connection, { transcript: 'hel', duration: 0.2 });
  results(connection, { transcript: 'hello', isFinal: true, duration: 0.5 });
  results(connection, { transcript: 'world', isFinal: true, duration: 1.1 });
  results(connection, { transcript: 'world!', duration: 1.2 });
  await channel.close();

  const ids = [...partials, ...finals].map((event) => event.itemId);
  assert.ok(ids.length >= 5);
  assert.equal(new Set(ids).size, ids.length, 'no two emissions share an itemId');
  assert.equal(ids.some((id) => id.endsWith('-flush')), false);
});

test('committed text is flushed at the cap instead of growing without bound', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  const chunk = 'a'.repeat(1000);
  for (let index = 0; index < 13; index += 1) {
    results(connection, { transcript: chunk, isFinal: true, start: index, duration: 0.5 });
    assert.ok(channel.committed.length <= channel.maxCommittedChars, 'committed stays bounded');
  }
  assert.ok(finals.length >= 1, 'the cap flushes a final');
  assert.ok(channel.committed.length <= channel.maxCommittedChars);
  await channel.close();
});

test('pre-connect replay retains buffers that were not sent', async () => {
  const errors = [];
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret',
    channel: 'you',
    sampleRate: 24000,
    drainTimeoutMs: 10,
    DeepgramClientImpl: DelayedDeepgramClient,
    onError: (error) => errors.push(error),
  });
  const connecting = channel.connect();
  await new Promise((resolve) => setImmediate(resolve));
  DelayedDeepgramClient.resolveFactory();
  await new Promise((resolve) => setImmediate(resolve));

  const first = Buffer.alloc(10, 1);
  const second = Buffer.alloc(10, 2);
  const third = Buffer.alloc(10, 3);
  assert.equal(channel.append(first), true);
  assert.equal(channel.append(second), true);
  assert.equal(channel.append(third), true);

  const connection = DelayedDeepgramClient.connection;
  let sends = 0;
  connection.sendMedia = (buffer) => {
    sends += 1;
    if (sends === 2) throw new Error('socket send failed');
    connection.media.push(Buffer.from(buffer));
  };
  connection.open();
  await connecting;

  assert.deepEqual(connection.media, [first], 'only the delivered buffer was consumed');
  assert.equal(channel.pendingAudio.length, 2, 'the unsent tail is retained');
  assert.deepEqual(channel.pendingAudio, [second, third]);
  assert.equal(channel.pendingAudioBytes, 20, 'the retained byte count matches the tail');
  assert.ok(errors.length >= 1);
  await channel.close();
});

test('an unexpected close clears state and stops append from queueing into a dead socket', async () => {
  const { channel, connection, errors } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  connection.emit('close', 1006, 'network lost');

  assert.equal(channel.opened, false);
  assert.equal(channel.connection, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'realtime_transport_failed');
  assert.equal(channel.append(Buffer.alloc(32)), false, 'append no longer accepts audio');
  await channel.close();
});

test('close after a synchronous SDK client-construction failure does not create an unhandled rejection', async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const channel = new DeepgramRealtimeChannel({
      apiKey: 'deepgram-secret',
      channel: 'you',
      DeepgramClientImpl: ThrowingClient,
    });
    const connecting = channel.connect();
    const closing = channel.close();
    await assert.rejects(connecting, /failed/i);
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('a listen.v1.connect() that never settles is bounded by the connect timeout', async () => {
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret',
    channel: 'you',
    connectTimeoutMs: 30,
    DeepgramClientImpl: NeverConnectingClient,
  });
  const started = Date.now();
  await assert.rejects(channel.connect(), /timed out/i);
  assert.ok(Date.now() - started < 1000, 'the timeout wins over a hung connect()');
  assert.equal(channel.opened, false);
});

test('auto language becomes multi on Nova-3, casing is preserved, and empty is omitted', () => {
  assert.equal(buildDeepgramOptions({ model: 'nova-3', language: 'auto' }).language, 'multi');
  assert.equal(buildDeepgramOptions({ model: 'nova-3', language: 'automatic' }).language, 'multi');
  assert.equal(buildDeepgramOptions({ model: 'nova-2', language: 'auto' }).language, 'multi');
  assert.equal(buildDeepgramOptions({ model: 'nova-3', language: 'zh-HK' }).language, 'zh-HK');
  assert.equal(buildDeepgramOptions({ model: 'nova-3', language: 'EN-us' }).language, 'EN-us');
  assert.equal('language' in buildDeepgramOptions({ model: 'nova-3', language: '   ' }), false);
});

test('keyterms are capped by both entry count and cumulative whitespace tokens', () => {
  const tenTokenTerms = Array.from({ length: 60 }, (_, index) => {
    const tail = Array.from({ length: 9 }, () => 'x').join(' ');
    return `term${index} ${tail}`;
  });
  const options = buildDeepgramOptions({ model: 'nova-3', keyterms: tenTokenTerms });
  assert.ok(options.keyterm.length <= 50, 'entry cap still applies');
  assert.equal(options.keyterm.length, 45, '450 token budget / 10 tokens per term');
  const totalTokens = options.keyterm
    .flatMap((term) => term.split(/\s+/))
    .filter(Boolean)
    .length;
  assert.ok(totalTokens <= 450);
});

test('a natural speech_final does not end the CloseStream drain early', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel({ drainTimeoutMs: 30 });
  const closing = channel.close();

  results(connection, { transcript: 'older endpoint', speechFinal: true, duration: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(connection.closed, 0, 'natural endpoint must not close the socket while CloseStream is pending');

  results(connection, { transcript: 'close tail', fromFinalize: true, duration: 2 });
  await closing;
  assert.deepEqual(finals.map((event) => event.text), ['older endpoint', 'close tail']);
  assert.equal(connection.closed, 1);
});

test('UtteranceEnd finishes the drain without waiting for the timeout', async () => {
  const { channel, connection } = await connectedDeepgramChannel({ drainTimeoutMs: 500 });
  const closing = channel.close();
  const started = Date.now();
  connection.emit('message', { type: 'UtteranceEnd', last_word_end: 0.8 });
  await closing;
  assert.ok(Date.now() - started < 200, 'UtteranceEnd should settle close promptly');
});

test('repeated empty speech_final boundaries do not merge utterances', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  results(connection, { transcript: 'first utterance', isFinal: true, start: 0, duration: 1 });
  results(connection, { transcript: '', isFinal: true, speechFinal: true, start: 0, duration: 1 });
  results(connection, { transcript: '', isFinal: true, speechFinal: true, start: 0, duration: 1 });
  results(connection, { transcript: 'second utterance', isFinal: true, start: 1, duration: 1 });
  await channel.close();
  assert.deepEqual(finals.map((event) => event.text), ['first utterance', 'second utterance']);
});

test('duplicate non-boundary is_final frames are emitted once', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  const frame = {
    type: 'Results', start: 0.3, duration: 0.4, is_final: true,
    channel: { alternatives: [{ transcript: 'one segment' }] },
  };
  connection.emit('message', frame);
  connection.emit('message', { ...frame });
  await channel.close();
  assert.deepEqual(finals.map((event) => event.text), ['one segment']);
});

test('retained replay audio is sent before newer audio', async () => {
  const errors = [];
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret', channel: 'you', sampleRate: 24000, drainTimeoutMs: 10,
    DeepgramClientImpl: DelayedDeepgramClient,
    onError: (error) => errors.push(error),
  });
  const connecting = channel.connect();
  await new Promise((resolve) => setImmediate(resolve));
  DelayedDeepgramClient.resolveFactory();
  await new Promise((resolve) => setImmediate(resolve));
  const first = Buffer.alloc(10, 1);
  const second = Buffer.alloc(10, 2);
  const third = Buffer.alloc(10, 3);
  channel.append(first);
  channel.append(second);
  const connection = DelayedDeepgramClient.connection;
  let failOnce = true;
  connection.sendMedia = (buffer) => {
    if (failOnce) { failOnce = false; throw new Error('temporary socket failure'); }
    connection.media.push(Buffer.from(buffer));
  };
  connection.open();
  await connecting;
  channel.append(third);
  assert.deepEqual(connection.media, [first, second, third]);
  assert.equal(channel.pendingAudio.length, 0);
  assert.ok(errors.length >= 1);
  await channel.close();
});

test('a throwing onFinal callback cannot reject close or skip teardown', async () => {
  const { channel, connection } = await connectedDeepgramChannel({
    drainTimeoutMs: 10,
    onFinal: () => { throw new Error('store write failed'); },
  });
  results(connection, { transcript: 'pending', isFinal: true });
  await channel.close();
  assert.equal(channel.closed, true);
  assert.equal(connection.closed, 1);
});

test('ConfigureFailure is non-fatal at the channel level', async () => {
  const { channel, connection, errors } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  connection.emit('message', { type: 'ConfigureFailure', message: 'unsupported keyterm deepgram-secret' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'realtime_configuration_failed');
  assert.equal(channel.opened, true);
  await channel.close();
});

test('a configuration failure does not hide a later fatal socket error', async () => {
  const { channel, connection, errors } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  connection.emit('message', { type: 'ConfigureFailure', message: 'unsupported keyterm' });
  connection.emit('error', new Error('401 invalid token'));
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map((error) => error.code), ['realtime_configuration_failed', 'realtime_authentication_failed']);
  await channel.close();
});

test('an is_final segment can be promoted to speech_final without being deduped away', async () => {
  const { channel, connection, finals } = await connectedDeepgramChannel({ drainTimeoutMs: 10 });
  const frame = {
    type: 'Results', start: 0.2, duration: 0.6, is_final: true,
    channel: { alternatives: [{ transcript: 'hello world' }] },
  };
  connection.emit('message', frame);
  connection.emit('message', { ...frame, speech_final: true });
  await channel.close();
  assert.deepEqual(finals.map((event) => event.text), ['hello world']);
});
