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

test.beforeEach(() => { FakeDeepgramClient.instances = []; });

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
  channel.close();
  assert.equal(client.connection.closeStreams, 1);
  assert.equal(client.connection.closed, 1);
});

test('Deepgram channel sanitizes failures and never includes the API key', async () => {
  const failures = [];
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret-value',
    channel: 'them',
    DeepgramClientImpl: FakeDeepgramClient,
    onError: (error) => failures.push(error),
  });
  await channel.connect();
  FakeDeepgramClient.instances[0].connection.emit('error', new Error('401 deepgram-secret-value invalid token'));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'realtime_authentication_failed');
  assert.doesNotMatch(JSON.stringify(failures[0]), /deepgram-secret-value/);
  channel.close();
});

test('Deepgram channel fails closed on SDK socket backpressure', async () => {
  const failures = [];
  const channel = new DeepgramRealtimeChannel({
    apiKey: 'deepgram-secret', channel: 'you', maxBufferedBytes: 100,
    DeepgramClientImpl: FakeDeepgramClient,
    onError: (error) => failures.push(error),
  });
  await channel.connect();
  FakeDeepgramClient.instances[0].connection.socket.bufferedAmount = 90;
  assert.equal(channel.append(Buffer.alloc(20)), false);
  assert.equal(failures[0].code, 'realtime_transport_failed');
  channel.close();
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
