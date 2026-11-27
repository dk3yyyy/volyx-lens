'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createFlushHarness({ vad = null } = {}) {
  const requests = [];
  const recorded = [];
  const vadCalls = { load: 0, detect: 0 };
  const context = {
    Buffer,
    console: { log() {}, warn() {} },
    flushPromises: { you: null, them: null },
    buffers: { you: [], them: [] },
    retryQueues: { you: [], them: [] },
    state: { transcribing: { you: false, them: false } },
    sessionGeneration: 1,
    transcriptEpoch: 1,
    transcriptProcessingOptions: { enabled: true, normalizeDigits: true, rules: [] },
    activeCustomVocabulary: '',
    sttDisabled: false,
    sttFailures: 0,
    sttBackoffUntil: 0,
    MAX_RETRY_CHUNKS: 100,
    MIN_BYTES: 1,
    RMS_GATE: 100,
    rms16: () => 1_000,
    getSpeechModel: (id) => (vad && id === 'local-stream-model' ? { id, runtime: 'transcribe-cpp', streaming: true } : null),
    isSpeechDetectorInstalled: () => Boolean(vad),
    mapVadSegments: (pcm, segments) => segments.map((segment) => ({ startByte: segment.startByte, endByte: segment.endByte, startMs: segment.startMs })),
    defaultSpeechWorker: {
      loadVad: async () => { vadCalls.load += 1; },
      detectSpeech: async () => {
        vadCalls.detect += 1;
        return vad || { speech: true, segments: [] };
      },
    },
    store: { getSettings: () => ({ transcription: vad ? { offlineEnabled: true, localModelId: 'local-stream-model' } : {}, audio: {} }) },
    personalContextStore: { getEnabledDocuments: () => [] },
    buildSttVocab: () => '',
    createSTT: () => ({
      available: true,
      transcribe: (pcm) => {
        const request = { pcm, ...deferred() };
        requests.push(request);
        return request.promise;
      },
    }),
    recordTranscript: (event, generation, epoch) => recorded.push({ event, generation, epoch }),
    handleSttError() {},
  };
  const start = main.indexOf('async function flushChannel(');
  const end = main.indexOf('async function drainBatchBuffers()', start);
  assert.ok(start >= 0 && end > start, 'main.js contains the batch flush function');
  const flushChannel = vm.runInNewContext(`(${main.slice(start, end)})`, context);
  return { context, requests, recorded, vadCalls, flushChannel };
}

test('a same-epoch flush detaches old audio without erasing newer PCM', async () => {
  const { context, requests, recorded, flushChannel } = createFlushHarness();
  const older = Buffer.from('older');
  const newer = Buffer.from('newer');
  context.buffers.you.push(older);

  const pending = flushChannel('you');
  const duplicate = flushChannel('you');
  assert.equal(requests.length, 1, 'an active same-epoch flush is reused');
  assert.deepEqual([...context.buffers.you], [], 'the active request owns a detached buffer');
  context.buffers.you.push(newer);

  requests[0].resolve({ text: 'older result' });
  await Promise.all([pending, duplicate]);

  assert.deepEqual([...context.buffers.you], [newer], 'an older success cannot erase PCM that arrived while it ran');
  assert.deepEqual([...context.retryQueues.you], [], 'successful audio is removed from the retry queue');
  assert.deepEqual(JSON.parse(JSON.stringify(recorded)), [{ event: { channel: 'you', text: 'older result' }, generation: 1, epoch: 1 }]);
});

test('an immediate-teardown epoch fence rejects stale results without clearing the replacement busy flag', async () => {
  const { context, requests, recorded, flushChannel } = createFlushHarness();
  context.buffers.you.push(Buffer.from('old session'));

  const stale = flushChannel('you');
  assert.equal(context.state.transcribing.you, true);

  // This is the synchronous state transition performed by immediate teardown and
  // pipeline restart. The old provider request deliberately remains unresolved.
  context.transcriptEpoch += 1;
  context.buffers.you = [Buffer.from('new session')];
  context.retryQueues.you = [];
  context.flushPromises.you = null;
  context.state.transcribing.you = false;

  const replacement = flushChannel('you');
  const replacementEntry = context.flushPromises.you;
  assert.equal(requests.length, 2, 'a new epoch starts a new request instead of reusing stale work');
  assert.equal(context.state.transcribing.you, true);

  requests[0].resolve({ text: 'stale result' });
  await stale;

  assert.deepEqual(recorded, [], 'a stale local batch result cannot record after restart');
  assert.equal(context.state.transcribing.you, true, 'a stale finally cannot clear the replacement busy flag');
  assert.equal(context.flushPromises.you, replacementEntry, 'a stale finally cannot clear the replacement promise entry');
  assert.deepEqual([...context.retryQueues.you], [Buffer.from('new session')], 'a stale result cannot clear replacement retry audio');

  requests[1].resolve({ text: 'fresh result' });
  await replacement;

  assert.deepEqual(JSON.parse(JSON.stringify(recorded)), [{ event: { channel: 'you', text: 'fresh result' }, generation: 1, epoch: 2 }]);
  assert.equal(context.state.transcribing.you, false);
  assert.equal(context.flushPromises.you, null);
  assert.deepEqual([...context.retryQueues.you], []);
});

test('the neural VAD gate drops detector-silent audio without calling the STT provider', async () => {
  const { context, requests, vadCalls, flushChannel } = createFlushHarness({ vad: { speech: false, segments: [] } });
  context.buffers.you.push(Buffer.from([0, 0, 0, 0]));

  await flushChannel('you');

  assert.equal(vadCalls.load, 1, 'the detector is loaded before detection');
  assert.equal(vadCalls.detect, 1);
  assert.equal(requests.length, 0, 'silent audio never reaches the batch provider');
  assert.deepEqual([...context.retryQueues.you], [], 'silent audio is dropped, not retried');
  assert.equal(context.state.transcribing.you, false);
});

test('VAD segments map to bounded per-range batches and per-segment transcript turns', async () => {
  const vad = {
    speech: true,
    segments: [
      { startByte: 0, endByte: 4, startMs: 0 },
      { startByte: 4, endByte: 8, startMs: 500 },
    ],
  };
  const { context, requests, recorded, flushChannel } = createFlushHarness({ vad });
  context.buffers.you.push(Buffer.from('abcdefgh'));

  const flushing = flushChannel('you');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1, 'ranges are transcribed one at a time');
  requests[0].resolve({ text: 'first', provider: 'openai' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  requests[1].resolve({ text: 'second', provider: 'openai' });
  await flushing;

  assert.equal(requests[0].pcm.toString(), 'abcd');
  assert.equal(requests[1].pcm.toString(), 'efgh');
  assert.deepEqual(recorded.map((entry) => entry.event.text), ['first', 'second']);
  assert.equal(typeof recorded[0].event.ts, 'number');
  assert.ok(recorded[1].event.ts >= recorded[0].event.ts + 500);
});
