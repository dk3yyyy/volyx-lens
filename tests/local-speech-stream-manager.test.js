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

test('stream manager forwards vocabulary and language to every channel', async () => {
  const worker = fakeWorker();
  const seen = [];
  const originalStart = worker.streamStart;
  worker.streamStart = async (options) => {
    seen.push({ channel: options.channel, language: options.language, vocabulary: options.vocabulary });
    return originalStart(options);
  };
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    language: 'en',
    vocabulary: ['Volyx', 'Kubernetes'],
  });
  await manager.start();
  assert.deepEqual(seen, [
    { channel: 'you', language: 'en', vocabulary: ['Volyx', 'Kubernetes'] },
    { channel: 'them', language: 'en', vocabulary: ['Volyx', 'Kubernetes'] },
  ]);
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
    // Wait past the original deadline but before the refreshed one, so a
    // heartbeat that returns true without re-arming the timer still fails.
    leaseMs: 2000,
    onError: (error) => errors.push(error),
  });
  await manager.start();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(manager.heartbeat('you'), true);
  await new Promise((resolve) => setTimeout(resolve, 1000));

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

test('queues a boundary per final and keeps audio from after the last one', async () => {
  const worker = fakeWorker();
  const events = worker.events;
  // Boundaries are fire-and-forget and finals are asynchronous: two VAD stops
  // can happen before either final arrives. Record only; emit the finals by
  // hand afterwards, in the order the worker would.
  worker.streamBoundary = async (channel) => {
    worker.calls.push(['boundary', channel]);
    return { queued: true };
  };
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    maxInFlight: 16,
    vad: { sampleRate: 24000, threshold: 100, silenceMs: 100, minSpeechMs: 20 },
  });
  await manager.start();

  const speech = (value) => {
    const chunk = Buffer.alloc(4800 * 2);
    for (let i = 0; i < 4800; i += 1) chunk.writeInt16LE(value, i * 2);
    return chunk;
  };
  const loudA = speech(6000);
  const quiet1 = Buffer.alloc(4800 * 2);
  const loudB = speech(6500);
  const quiet2 = Buffer.alloc(4800 * 2);
  const post = speech(7000);

  assert.equal(manager.append('you', loudA), true);
  assert.equal(manager.append('you', quiet1), true);   // boundary #1 at 2 chunks
  assert.equal(manager.append('you', loudB), true);
  assert.equal(manager.append('you', quiet2), true);   // boundary #2 at 4 chunks
  assert.equal(manager.append('you', post), true);     // belongs after boundary #2
  assert.equal(worker.calls.filter(([kind]) => kind === 'boundary').length, 2);

  // The first final must consume only the first two chunks and leave the
  // second utterance intact; the second consumes that and leaves `post`.
  events.emit('event', { type: 'speech.final', channel: 'you', data: { text: 'first' } });
  events.emit('event', { type: 'speech.final', channel: 'you', data: { text: 'second' } });
  await new Promise((resolve) => setImmediate(resolve));

  const recovered = manager.takeRecoveryAudio();
  assert.equal(recovered.you.length, 1, 'audio after the last boundary survives both finals');
  assert.deepEqual(recovered.you[0], post);
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

// 100 ms of 24 kHz mono 16-bit PCM.
const WINDOW_CHUNK_MS = 100;
const WINDOW_CHUNK_SAMPLES = 2_400;

function speechChunk() {
  const chunk = Buffer.alloc(WINDOW_CHUNK_SAMPLES * 2);
  for (let index = 0; index < WINDOW_CHUNK_SAMPLES; index += 1) chunk.writeInt16LE(2_000, index * 2);
  return chunk;
}

function boundaryFeedPositions(worker) {
  return worker.calls
    .map(([kind], index) => (kind === 'boundary'
      ? worker.calls.slice(0, index).filter(([call]) => call === 'feed').length
      : null))
    .filter((position) => position !== null);
}

test('cuts 30 s of continuous speech at the default 25 s window', async () => {
  const worker = fakeWorker();
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    // Enough in-flight room for a synchronous burst, and a VAD max utterance
    // far past the window so only the forced cut can fire.
    maxInFlight: 512,
    vad: { threshold: 100, silenceMs: 1_000, maxUtteranceMs: 600_000 },
  });
  await manager.start();
  const speech = speechChunk();

  for (let index = 0; index < 300; index += 1) {
    assert.equal(manager.append('you', speech), true);
  }

  const boundaries = worker.calls.filter(([kind]) => kind === 'boundary');
  assert.equal(boundaries.length, 1, 'one monologue produces exactly one forced cut');
  // 30 s fed in 100 ms chunks; the cut lands on the chunk that reaches 25 s.
  assert.deepEqual(boundaryFeedPositions(worker), [25_000 / WINDOW_CHUNK_MS]);
  assert.equal(manager.windowMs.you, 5_000, 'the counter restarts at the boundary');
  assert.equal(manager.ready, true, 'the stream keeps running after a forced cut');
  await manager.stop();
});

test('a VAD boundary resets the forced window', async () => {
  const worker = fakeWorker();
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    maxInFlight: 512,
    vad: { threshold: 100, silenceMs: 100, minSpeechMs: 20, maxUtteranceMs: 600_000 },
  });
  await manager.start();
  const speech = speechChunk();
  const silence = Buffer.alloc(WINDOW_CHUNK_SAMPLES * 2);

  // 20 s of speech, then a 100 ms pause: the VAD closes the utterance long
  // before the 25 s window bound.
  for (let index = 0; index < 200; index += 1) {
    assert.equal(manager.append('you', speech), true);
  }
  assert.equal(manager.append('you', silence), true);
  assert.equal(worker.calls.filter(([kind]) => kind === 'boundary').length, 1);
  // Let the boundary call settle; a real stream feeds across ticks, and the
  // forced cut waits for an in-flight boundary to resolve.
  await new Promise((resolve) => setImmediate(resolve));

  // 24 s more is inside the restarted window, so no forced cut yet.
  for (let index = 0; index < 240; index += 1) {
    assert.equal(manager.append('you', speech), true);
  }
  assert.equal(worker.calls.filter(([kind]) => kind === 'boundary').length, 1);

  for (let index = 0; index < 10; index += 1) {
    assert.equal(manager.append('you', speech), true);
  }
  assert.equal(worker.calls.filter(([kind]) => kind === 'boundary').length, 2);
  assert.deepEqual(boundaryFeedPositions(worker), [201, 451]);
  await manager.stop();
});

test('a refused append does not advance the window or queue a boundary', async () => {
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
    maxWindowMs: 1_000,
    vad: { threshold: 100, silenceMs: 1_000, maxUtteranceMs: 600_000 },
    onError: (error) => errors.push(error),
  });
  await manager.start();
  const speech = speechChunk();

  assert.equal(manager.append('you', speech), true);
  assert.equal(manager.append('you', speech), false, 'the stalled worker refuses audio');
  assert.equal(errors[0].code, 'speech_stream_backpressure');
  assert.equal(manager.windowMs.you, WINDOW_CHUNK_MS, 'only accepted audio counts');
  assert.equal(worker.calls.filter(([kind]) => kind === 'boundary').length, 0);

  releaseFeed();
  await manager.stop();
});

test('does not queue a forced boundary while one is still in flight', async () => {
  let resolveBoundary;
  const worker = fakeWorker();
  worker.streamBoundary = (channel) => {
    worker.calls.push(['boundary', channel]);
    return new Promise((resolve) => { resolveBoundary = resolve; });
  };
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    maxInFlight: 512,
    maxWindowMs: 1_000,
    vad: { threshold: 100, silenceMs: 1_000, maxUtteranceMs: 600_000 },
  });
  await manager.start();
  const speech = speechChunk();

  for (let index = 0; index < 10; index += 1) manager.append('you', speech);
  assert.equal(worker.calls.filter(([kind]) => kind === 'boundary').length, 1);
  assert.equal(manager.windowMs.you, 0);

  // Two more windows' worth of audio while the first cut is unresolved: the
  // manager must wait rather than stack a duplicate boundary behind it.
  for (let index = 0; index < 20; index += 1) manager.append('you', speech);
  assert.equal(worker.calls.filter(([kind]) => kind === 'boundary').length, 1);
  assert.equal(manager.windowMs.you, 2_000, 'audio keeps counting while the cut is in flight');

  resolveBoundary();
  await new Promise((resolve) => setImmediate(resolve));
  manager.append('you', speech);
  assert.equal(worker.calls.filter(([kind]) => kind === 'boundary').length, 2);
  assert.equal(manager.windowMs.you, 0, 'the delayed cut still resets the window');
  await manager.stop();
});

test('stop clears the window so nothing cuts after the stream ends', async () => {
  const worker = fakeWorker();
  const manager = createLocalSpeechStreamManager({
    worker,
    modelId: 'parakeet-unified-en',
    channels: ['you'],
    maxInFlight: 32,
    maxWindowMs: 1_000,
    vad: { threshold: 100, silenceMs: 1_000, maxUtteranceMs: 600_000 },
  });
  await manager.start();
  const speech = speechChunk();

  for (let index = 0; index < 9; index += 1) assert.equal(manager.append('you', speech), true);
  assert.equal(manager.windowMs.you, 900);
  await manager.stop();

  assert.deepEqual(manager.windowMs, { you: 0 });
  assert.equal(manager.append('you', speech), false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(worker.calls.filter(([kind]) => kind === 'boundary').length, 0);
});

