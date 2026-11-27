'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLocalSpeechStreamManager } = require('../src/local-speech-stream-manager');

function fakeWorker({ failChannel = '', feed = async () => {} } = {}) {
  const calls = [];
  const events = new EventEmitter();
  return {
    calls,
    events,
    async streamStart(options) {
      calls.push(['start', options.channel]);
      if (options.channel === failChannel) throw new Error(`cannot start ${failChannel}`);
      return { modelId: options.modelId };
    },
    async streamFeed(channel, pcm) {
      calls.push(['feed', channel, pcm]);
      return feed(channel, pcm);
    },
    async streamBoundary(channel) {
      calls.push(['boundary', channel]);
      events.emit('event', { type: 'speech.final', channel, data: { text: `${channel} utterance` } });
      return { queued: true };
    },
    async streamFinish(channel) {
      calls.push(['finish', channel]);
      events.emit('event', { type: 'speech.final', channel, data: { text: `${channel} final` } });
      return { finished: true };
    },
    async streamCancel(channel) {
      calls.push(['cancel', channel]);
      return { finished: false };
    },
  };
}

test('streams each enabled channel and forwards partial and final transcript events', async () => {
  const worker = fakeWorker();
  const partials = [];
  const finals = [];
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you', 'them'],
    onPartial: (event) => partials.push(event),
    onFinal: (event) => finals.push(event),
  });

  await manager.start();
  assert.equal(manager.ready, true);
  assert.equal(manager.append('you', Buffer.from([1, 0])), true);
  worker.events.emit('event', { type: 'speech.partial', channel: 'you', data: { full: 'hello' } });
  await manager.stop({ finish: true });

  assert.deepEqual(worker.calls.slice(0, 2), [['start', 'you'], ['start', 'them']]);
  assert.equal(worker.calls.some(([kind]) => kind === 'feed'), true);
  assert.deepEqual(partials, [{ channel: 'you', full: 'hello' }]);
  assert.deepEqual(finals, [
    { channel: 'you', text: 'you final' },
    { channel: 'them', text: 'them final' },
  ]);
  assert.equal(manager.ready, false);
});

test('stream manager forwards the selected compute backend to every channel', async () => {
  const worker = fakeWorker();
  const seen = [];
  const originalStart = worker.streamStart;
  worker.streamStart = async (options) => { seen.push(options.backend); return originalStart(options); };
  const manager = createLocalSpeechStreamManager({ worker, modelId: 'parakeet-unified-en', backend: 'cpu' });
  await manager.start();
  assert.deepEqual(seen, ['cpu', 'cpu']);
  await manager.stop();
});

test('cancels the first stream when the second channel cannot load', async () => {
  const worker = fakeWorker({ failChannel: 'them' });
  const manager = createLocalSpeechStreamManager({ worker, modelId: 'nemotron-3.5-asr-streaming-0.6b' });

  await assert.rejects(manager.start(), /cannot start them/);

  assert.deepEqual(worker.calls, [['start', 'you'], ['start', 'them'], ['cancel', 'you']]);
  assert.equal(worker.events.listenerCount('event'), 0);
});

test('stopping during stream startup waits for and cancels the in-flight model load', async () => {
  const worker = fakeWorker();
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const originalStart = worker.streamStart;
  worker.streamStart = async (options) => {
    await startGate;
    return originalStart(options);
  };
  const manager = createLocalSpeechStreamManager({ worker, modelId: 'parakeet-unified-en' });

  const startup = manager.start();
  const stopping = manager.stop();
  releaseStart();
  await assert.rejects(startup, { code: 'speech_stream_start_cancelled' });
  await stopping;

  assert.equal(worker.calls.some(([kind]) => kind === 'cancel'), true);
  assert.equal(manager.ready, false);
});

test('stream failure exposes bounded recovery audio before batch fallback', async () => {
  const worker = fakeWorker();
  const errors = [];
  let recovered;
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    onError: (error) => {
      errors.push(error);
      recovered = manager.takeRecoveryAudio();
    },
  });
  await manager.start();
  const pcm = Buffer.from([1, 0, 2, 0]);

  assert.equal(manager.append('you', pcm), true);
  worker.events.emit('event', { type: 'speech.error', channel: 'you', data: { code: 'speech_stream_failed' } });

  assert.equal(errors.length, 1);
  assert.deepEqual(recovered.you, [pcm]);
  assert.deepEqual(manager.takeRecoveryAudio().you, []);
  await manager.stop();
});

test('reports backpressure once and stops accepting stream audio', async () => {
  let releaseFeed;
  const worker = fakeWorker({
    feed: () => new Promise((resolve) => { releaseFeed = resolve; }),
  });
  const errors = [];
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    maxInFlight: 1,
    onError: (error) => errors.push(error),
  });
  await manager.start();

  assert.equal(manager.append('you', Buffer.from([1, 0])), true);
  assert.equal(manager.append('you', Buffer.from([2, 0])), false);
  assert.equal(manager.append('you', Buffer.from([3, 0])), false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'speech_stream_backpressure');

  releaseFeed();
  await manager.stop();
});

test('finalizes utterances after configured silence without stopping the stream', async () => {
  const worker = fakeWorker();
  const finals = [];
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    vad: { threshold: 100, silenceMs: 300, maxUtteranceMs: 1_000 },
    onFinal: (event) => finals.push(event),
  });
  await manager.start();
  const speech = Buffer.alloc(24_000 * 2 * 0.12);
  for (let offset = 0; offset < speech.length; offset += 2) speech.writeInt16LE(2_000, offset);
  const silence = Buffer.alloc(24_000 * 2 * 0.4);

  assert.equal(manager.append('you', speech), true);
  assert.equal(manager.append('you', silence), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(worker.calls.some(([kind, channel]) => kind === 'boundary' && channel === 'you'), true);
  assert.equal(manager.ready, true);
  assert.deepEqual(finals, [{ channel: 'you', text: 'you utterance' }]);
  await manager.stop();
});

test('a silent channel lease expires, cancels that stream, and surfaces the error', async () => {
  const worker = fakeWorker();
  const errors = [];
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    leaseMs: 25,
    onError: (error) => errors.push(error),
  });
  await manager.start();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'speech_stream_lease_expired');
  assert.equal(worker.calls.some(([kind, channel]) => kind === 'cancel' && channel === 'you'), true);
  assert.equal(manager.ready, false);
  assert.equal(manager.heartbeat('you'), false, 'an expired channel no longer accepts heartbeats');
  await manager.stop();
});

test('a heartbeat refreshes the channel lease without new audio', async () => {
  const worker = fakeWorker();
  const errors = [];
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    // Wide margins on purpose: the point is that a heartbeat re-arms the
    // lease, not that a loaded CI runner can schedule a 35 ms sleep exactly.
    leaseMs: 300,
    onError: (error) => errors.push(error),
  });
  await manager.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(manager.heartbeat('you'), true);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(errors, [], 'the refreshed lease has not expired yet');
  assert.equal(manager.ready, true);
  await manager.stop();
});

test('refuses new audio once the per-channel backlog bound is exceeded', async () => {
  let releaseFeed;
  const worker = fakeWorker({
    feed: () => new Promise((resolve) => { releaseFeed = resolve; }),
  });
  const errors = [];
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    maxInFlight: 10,
    maxBacklogSeconds: 0.0002,
    onError: (error) => errors.push(error),
  });
  await manager.start();

  assert.equal(manager.append('you', Buffer.from([1, 0])), true);
  assert.equal(manager.append('you', Buffer.alloc(16)), false, 'audio past the 120s bound is refused');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'speech_stream_backlog_exceeded');
  assert.equal(manager.ready, false);

  releaseFeed();
  await manager.stop();
});

test('backlog catches up after a stalled feed drains and the utterance finalizes', async () => {
  let releaseFeed;
  const worker = fakeWorker({
    feed: () => new Promise((resolve) => { releaseFeed = resolve; }),
  });
  const finals = [];
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    maxInFlight: 8,
    onFinal: (event) => finals.push(event),
  });
  await manager.start();
  const pcm = Buffer.from([1, 0, 2, 0]);

  assert.equal(manager.append('you', pcm), true);
  assert.equal(manager.append('you', pcm), true);
  assert.equal(manager.backlogBytes.you, 8, 'undelivered audio is tracked, not dropped');
  assert.equal(manager.ready, true, 'a stalled feed below the bound does not fail the stream');

  releaseFeed();
  await new Promise((resolve) => setImmediate(resolve));
  worker.events.emit('event', { type: 'speech.final', channel: 'you', data: { text: 'caught up' } });

  assert.equal(manager.backlogBytes.you, 0, 'a final settles the channel backlog');
  assert.deepEqual(finals, [{ channel: 'you', text: 'caught up' }]);
  assert.equal(manager.append('you', pcm), true, 'the channel accepts audio again after catching up');
  await manager.stop();
});

test('stream finish is cancelled when it misses the deadline so Stop cannot hang', async () => {
  const worker = fakeWorker();
  worker.streamFinish = (channel) => {
    worker.calls.push(['finish', channel]);
    return new Promise(() => {});
  };
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    finishDeadlineMs: 25,
  });
  await manager.start();

  const startedAt = Date.now();
  await assert.rejects(manager.stop({ finish: true }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].code, 'speech_stream_finish_timeout');
    return true;
  });
  assert.ok(Date.now() - startedAt < 1000, 'stop settles instead of waiting on the worker');
  assert.equal(worker.calls.some(([kind, channel]) => kind === 'cancel' && channel === 'you'), true);
});

test('finals-only when the worker cannot stream partials', async () => {
  // A backend may only produce finalized utterances and never a partial. The
  // manager must still deliver finals and must not invent partials of its own.
  const worker = fakeWorker();
  worker.streamFeed = async (channel) => {
    worker.calls.push(['feed', channel]);
    worker.events.emit('event', { type: 'speech.final', channel, data: { text: `${channel} only final` } });
    return { queued: true };
  };
  const partials = [];
  const finals = [];
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    onPartial: (event) => partials.push(event),
    onFinal: (event) => finals.push(event),
  });
  await manager.start();

  assert.equal(manager.append('you', Buffer.from([1, 0, 2, 0])), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(partials, []);
  assert.deepEqual(finals, [{ channel: 'you', text: 'you only final' }]);
  await manager.stop();
});

test('a final keeps audio captured after its boundary', async () => {
  const worker = fakeWorker();
  const events = worker.events;
  // Emit the final one tick after the boundary so audio appended in between
  // belongs to the next utterance.
  worker.streamBoundary = async (channel) => {
    worker.calls.push(['boundary', channel]);
    setTimeout(() => events.emit('event', { type: 'speech.final', channel, data: { text: 'first' } }), 0);
    return { queued: true };
  };
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    vad: { sampleRate: 24000, threshold: 100, silenceMs: 100, minSpeechMs: 20 },
  });
  await manager.start();

  const loud = Buffer.alloc(4800 * 2);
  for (let i = 0; i < 4800; i += 1) loud.writeInt16LE(6000, i * 2);
  const quiet = Buffer.alloc(4800 * 2);
  const next = Buffer.alloc(2400 * 2);
  for (let i = 0; i < 2400; i += 1) next.writeInt16LE(7000, i * 2);

  assert.equal(manager.append('you', loud), true);
  assert.equal(manager.append('you', quiet), true);
  assert.equal(manager.append('you', next), true, 'audio after the boundary is accepted');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const recovered = manager.takeRecoveryAudio();
  assert.equal(recovered.you.length, 1, 'only the post-boundary chunk remains for fallback');
  assert.deepEqual(recovered.you[0], next);
  await manager.stop();
});

test('stop settles when the worker never answers cancel', async () => {
  const worker = fakeWorker();
  worker.streamCancel = () => new Promise(() => {});
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    finishDeadlineMs: 25,
  });
  await manager.start();
  const startedAt = Date.now();
  await assert.rejects(manager.stop(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].code, 'speech_stream_cancel_timeout');
    return true;
  });
  assert.ok(Date.now() - startedAt < 1000, 'stop settles instead of waiting on cancel');
});
