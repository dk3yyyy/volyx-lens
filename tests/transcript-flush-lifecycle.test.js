'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mainFunction(startMarker, endMarker) {
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `could not extract ${startMarker}`);
  return main.slice(start, end);
}

function createFlushHarness(overrides = {}) {
  const transcriptions = [];
  const recorded = [];
  const events = [];
  const context = {
    Buffer,
    console,
    sessionGeneration: 7,
    transcriptEpoch: 11,
    transcriptProcessingOptions: { enabled: true, normalizeDigits: true, rules: [] },
    activeCustomVocabulary: '',
    flushPromises: { you: null, them: null },
    buffers: { you: [], them: [] },
    retryQueues: { you: [], them: [] },
    state: { transcribing: { you: false, them: false } },
    sttDisabled: false,
    sttFailures: 0,
    sttBackoffUntil: 0,
    STT_RETRY_BASE_MS: 8000,
    STT_RETRY_MAX_MS: 120000,
    MIN_BYTES: 32,
    RMS_GATE: 240,
    AUDIO_SAMPLE_RATE: 24000,
    MAX_RETRY_CHUNKS: 180,
    MAX_RETRY_BYTES: 24000 * 2 * 120,
    boundRetryQueue() {},
    transcriptionMode: 'batch',
    realtimeManager: null,
    drainingRealtimeManagers: new Set(),
    micEchoCoordinator: { clear() {} },
    acousticEchoFilter: { reset() {} },
    store: { getSettings: () => ({}) },
    personalContextStore: { getEnabledDocuments: () => [] },
    buildSttVocab: () => '',
    rms16: () => 1000,
    getSpeechModel: () => null,
    isSpeechDetectorInstalled: () => false,
    mapVadSegments: () => [],
    defaultSpeechWorker: { loadVad: async () => {}, detectSpeech: async () => ({ speech: true, segments: [] }), stop: async () => {} },
    localSpeechStreamManager: null,
    localManager: undefined,
    stopSpeechWorkerAfterStreamFailure: async () => true,
    createSTT: () => {
      const transcription = deferred();
      transcriptions.push(transcription);
      return { available: true, transcribe: () => transcription.promise };
    },
    recordTranscript: ({ text }) => recorded.push(text),
    handleSttError() {},
    send(channel, payload) { events.push({ channel, payload }); },
    updateTranscriptionDiagnostics() {},
    stopFlushLoop() {},
    cancelOfflineTranscriptions() {},
    ...overrides,
  };
  vm.runInNewContext(
    `${mainFunction('async function flushChannel(', 'async function drainBatchBuffers()')}\n`
    + `${mainFunction('async function stopTranscriptionPipeline(', 'function routePcm(')}\n`,
    context,
  );
  return { context, transcriptions, recorded, events };
}

test('immediate teardown invalidates a deferred batch flush before the same session retries', async () => {
  const { context, transcriptions, recorded } = createFlushHarness();
  context.buffers.you.push(Buffer.alloc(context.MIN_BYTES));

  const oldFlush = context.flushChannel('you');
  const sameRunFlush = context.flushChannel('you');
  assert.equal(transcriptions.length, 1, 'a same-run flush reuses the active provider call');
  assert.equal(context.state.transcribing.you, true);

  await context.stopTranscriptionPipeline({ immediate: true });
  assert.equal(context.flushPromises.you, null, 'teardown forgets the old flush handle');
  assert.equal(context.state.transcribing.you, false);

  // Retry/stop-start keeps the session generation and transcript, but starts a
  // new pipeline run. The new provider call overlaps the old deferred one.
  context.transcriptionMode = 'batch';
  context.buffers.you.push(Buffer.alloc(context.MIN_BYTES));
  const newFlush = context.flushChannel('you');
  assert.equal(transcriptions.length, 2, 'the retry starts while the pre-teardown STT call is still pending');
  assert.equal(context.state.transcribing.you, true);

  transcriptions[0].resolve({ text: 'pre-teardown audio' });
  await Promise.all([oldFlush, sameRunFlush]);
  assert.deepEqual(
    { recorded, transcribing: context.state.transcribing.you },
    { recorded: [], transcribing: true },
    'the stale result neither records nor clears the new pipeline transcribing flag',
  );
  assert.ok(context.flushPromises.you, 'the stale completion does not forget the new flush handle');

  transcriptions[1].resolve({ text: 'new audio' });
  await newFlush;
  assert.deepEqual(recorded, ['new audio']);
  assert.equal(context.state.transcribing.you, false);
  assert.equal(context.flushPromises.you, null);
});

test('a teardown that started before a newer pipeline run cannot clear its buffers', async () => {
  const { context, events } = createFlushHarness();
  const closed = deferred();
  context.transcriptionMode = 'realtime';
  context.realtimeManager = { stop: () => closed.promise };

  const stopping = context.stopTranscriptionPipeline({ immediate: true });
  assert.equal(context.transcriptEpoch, 12, 'the teardown invalidated its own pipeline run');

  // While the provider is still closing, a second clear (or a New Session behind
  // it) invalidates this run and a new pipeline starts capturing.
  context.transcriptEpoch += 1;
  context.buffers.them.push(Buffer.alloc(context.MIN_BYTES));
  context.retryQueues.them.push(Buffer.alloc(context.MIN_BYTES));
  context.state.transcribing.them = true;

  closed.resolve();
  const outcome = await stopping;

  assert.equal(outcome && outcome.applied, false, 'the superseded teardown reports that it did nothing');
  assert.equal(context.buffers.them.length, 1, 'the newer run keeps the audio it buffered');
  assert.equal(context.retryQueues.them.length, 1, 'the newer run keeps its detached retry attempt');
  assert.equal(context.state.transcribing.them, true, 'the stale teardown does not clear the new busy flag');
  assert.equal(context.transcriptionMode, 'realtime', 'the stale teardown does not report the new run idle');
  assert.equal(events.filter((event) => event.channel === 'transcription:state').length, 0);
});
