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

function createFlushHarness() {
  const transcriptions = [];
  const recorded = [];
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
    MAX_RETRY_CHUNKS: 180,
    transcriptionMode: 'batch',
    realtimeManager: null,
    drainingRealtimeManagers: new Set(),
    micEchoCoordinator: { clear() {} },
    acousticEchoFilter: { reset() {} },
    store: { getSettings: () => ({}) },
    personalContextStore: { getEnabledDocuments: () => [] },
    buildSttVocab: () => '',
    rms16: () => 1000,
    createSTT: () => {
      const transcription = deferred();
      transcriptions.push(transcription);
      return { available: true, transcribe: () => transcription.promise };
    },
    recordTranscript: ({ text }) => recorded.push(text),
    handleSttError() {},
    send() {},
    updateTranscriptionDiagnostics() {},
    stopFlushLoop() {},
    cancelOfflineTranscriptions() {},
  };
  vm.runInNewContext(
    `${mainFunction('async function flushChannel(', 'async function drainBatchBuffers()')}\n`
    + `${mainFunction('async function stopTranscriptionPipeline(', 'function routePcm(')}\n`,
    context,
  );
  return { context, transcriptions, recorded };
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
