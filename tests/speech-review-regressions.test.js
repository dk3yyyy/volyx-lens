'use strict';

// Regressions for the speech review findings that live in main.js only:
// B1 (Stop blocked by diarization), H2 (startup replay ordering), M2 (stream
// lease refresh) and the privacy routing handled by main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDiarizationRecorder } = require('../src/diarization-session');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function sourceBlock(startMarker, endMarker) {
  const start = main.indexOf(startMarker);
  assert.ok(start >= 0, `could not find ${startMarker}`);
  const end = endMarker ? main.indexOf(endMarker, start) : main.length;
  assert.ok(end > start, `could not find ${endMarker} after ${startMarker}`);
  return main.slice(start, end);
}

function createCaptureHarness({ gateBusy = false } = {}) {
  const state = { capturing: true };
  const events = [];
  const recorder = createDiarizationRecorder({
    recordingId: 'diar-b1',
    sampleRate: 24000,
    maxMinutes: 5,
  });
  recorder.append(Buffer.alloc(4800, 9));
  const gateCalls = [];
  const context = vm.createContext({
    Buffer,
    console: { warn() {}, error() {}, log() {} },
    AUDIO_SAMPLE_RATE: 24000,
    createDiarizationRecorder,
    captureGeneration: 0,
    acousticCoupling: { reset() {} },
    acousticEchoFilter: { reset() {} },
    echoGapFill: { reset() {} },
    state,
    desiredCapturing: false,
    pendingStopImmediate: false,
    pendingStopReason: null,
    systemAudioCapture: { stop: async () => {} },
    linuxMonitorCapture: { stop: async () => {} },
    micEchoCoordinator: { clear() {}, drain() {} },
    acousticEchoFilter: { reset() {} },
    resetEchoState: () => {},
    stopSlideTracking() {},
    captureStartedAt: 1000,
    lastCaptureEndedAt: 2000,
    clearCaptureTimers() {},
    captureWarningTimer: null,
    captureLimitTimer: null,
    send: (channel, payload) => events.push({ channel, payload }),
    stopTranscriptionPipeline: async () => {},
    finalizeMeeting: () => ({ id: 'meeting-b1' }),
    meetingDetector: { reset() {} },
    meetingDetectedNotified: false,
    activeMeetingRecordId: null,
    defaultSpeechWorker: { stop: async () => {}, loadedModelId: '' },
    store: { getSettings: () => ({ transcription: { historyEnabled: true, diarization: { enabled: true } } }) },
    speechDiarizerInfo: () => ({ id: 'diar-test', sampleRate: 16000, artifact: { sha256: 'abc' } }),
    isSpeechDiarizerInstalled: () => true,
    pcmToWav: () => Buffer.alloc(16),
    speechOperationGate: {
      isBusy: () => gateBusy,
      whenIdle: async () => {},
      run: (label, operation) => {
        if (gateBusy) {
          return Promise.reject(Object.assign(new Error('busy'), { code: 'speech_model_operation_in_progress' }));
        }
        gateCalls.push({ label, operation });
        // A real Sortformer run can take minutes. The stop must not wait for it.
        return new Promise(() => {});
      },
    },
    themSilenceWatchdog: { arm() {}, disarm() {}, reset() {}, feed() {} },
  });
  const script = `${sourceBlock('function clearDiarizationRecorder()', 'async function reconcileCaptureState()')}
globalThis.api = {
  applyCaptureState,
  arm(rec) { diarizationRecorder = rec; diarizationRunConfig = { preset: 'high_latency', backend: 'auto' }; },
  get recorder() { return diarizationRecorder; },
};`;
  vm.runInContext(script, context);
  context.api.arm(recorder);
  return { api: context.api, context, state, events, gateCalls, recorder };
}

test('B1: a stop resolves without waiting for the diarization analysis', async () => {
  const harness = createCaptureHarness();
  const result = await Promise.race([
    harness.api.applyCaptureState(false),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 250)),
  ]);
  assert.notEqual(result, 'blocked', 'applyCaptureState must not await Sortformer');
  assert.equal(result, false);
  assert.equal(harness.state.capturing, false);
  // The recorder is detached synchronously: the next session cannot adopt it.
  assert.equal(harness.api.recorder, null);
  assert.equal(harness.recorder.bytes > 0, true, 'the analysis still owns the audio');
  assert.equal(harness.gateCalls.length, 1, 'the run was handed to the gate');
  assert.equal(harness.gateCalls[0].label, 'diarization');
  const stateEvent = harness.events.find((event) => event.channel === 'capture:state');
  assert.equal(stateEvent.payload.active, false);
});

test('B1: a busy speech gate is reported, not surfaced as a failed stop', async () => {
  const harness = createCaptureHarness({ gateBusy: true });
  const result = await harness.api.applyCaptureState(false);
  assert.equal(result, false, 'the stop succeeds');
  assert.equal(harness.state.capturing, false);
  assert.equal(harness.api.recorder, null);
  // The audio the analysis could not take is dropped, not left in RAM.
  assert.equal(harness.recorder.bytes, 0);
  const message = harness.events
    .filter((event) => event.payload && event.payload.message)
    .map((event) => event.payload.message)
    .join('\n');
  assert.match(message, /Speaker activity was skipped/);
});

function createReplayHarness() {
  const buffers = { you: [], them: [] };
  const retryQueues = { you: [], them: [] };
  const state = { capturing: true };
  const order = [];
  let injected = false;
  const context = vm.createContext({
    Buffer,
    console: { warn() {}, error() {}, log() {} },
    setImmediate,
    setInterval,
    clearInterval,
    AUDIO_SAMPLE_RATE: 24000,
    MAX_BATCH_CHUNKS: 180,
    captureGeneration: 0,
    acousticCoupling: { reset() {} },
    acousticEchoFilter: { reset() {} },
    echoGapFill: { reset() {} },
    LOCAL_SPEECH_LEASE_REFRESH_MS: 3000,
    localSpeechLeaseTimer: null,
    buffers,
    retryQueues,
    state,
    transcriptionMode: 'idle',
    sessionGeneration: 3,
    transcriptEpoch: 4,
    diarizationRecorder: null,
    activeCustomVocabulary: '',
    transcriptProcessingOptions: { enabled: true, normalizeDigits: true, rules: [] },
    realtimeManager: null,
    localSpeechStreamManager: null,
    store: {
      getSettings: () => ({
        transcription: {
          offlineEnabled: true,
          localModelId: 'local-stream-model',
          diarization: { enabled: false },
        },
        audio: { micEnabled: true, systemEnabled: true },
      }),
    },
    resolveRealtimeTranscription: () => ({ ready: false }),
    resolveVadSettings: () => ({}),
    getSpeechModel: () => ({ id: 'local-stream-model', runtime: 'transcribe-cpp', streaming: true }),
    resolveTranscriptionMode: () => 'local-stream',
    speechModelsWithStatus: () => [{ id: 'local-stream-model', installed: true, runtime: 'transcribe-cpp', streaming: true }],
    resolveSpeechWorkerBinary: () => ({ available: true }),
    os: { totalmem: () => 8 * 1024 * 1024 * 1024 },
    createLocalSpeechStreamManager: () => context.manager,
    buildSttTermList: () => [],
    personalContextStore: { getEnabledDocuments: () => [] },
    parseTranscriptRules: () => [],
    clampLocalLanguage: (language) => language,
    recordTranscript() {},
    updateTranscriptionDiagnostics() {},
    send() {},
    startFlushLoop() {},
    stopFlushLoop() {},
    queueRecoveredAudioForBatch() {},
    boundRetryQueue() {},
    stopSpeechWorkerAfterStreamFailure: async () => true,
    startDiarizationRecorder() {},
    startLocalSpeechLeaseRefresh() {},
    stopLocalSpeechLeaseRefresh() {},
    defaultSpeechWorker: { stop: async () => {} },
  });
  context.manager = {
    channels: ['you', 'them'],
    append(channel, pcm) {
      order.push(`${channel}:${pcm.toString()}`);
      if (channel === 'you' && !injected) {
        injected = true;
        // A live system-audio chunk arrives while the `you` channel replays.
        assert.equal(context.replayingChannels.has('them'), true, 'them must be held during the you replay');
        context.routePcm('them', Buffer.from('them-live'));
      }
      return true;
    },
    async start() {
      // Audio captured while the stream was starting is what replay exists for.
      buffers.you.push(Buffer.from('you-old'));
      buffers.them.push(Buffer.from('them-old'));
    },
    async stop() {},
    heartbeat() { return true; },
    takeRecoveryAudio() { return { you: [], them: [] }; },
  };
  const script = [
    sourceBlock('async function replayBufferedStartupAudio(', 'async function stopTranscriptionPipeline('),
    sourceBlock('const replayingChannels = new Set();', 'function processMicrophonePcm('),
    'globalThis.replayingChannels = replayingChannels;',
    'globalThis.routePcm = routePcm;',
    'globalThis.startTranscriptionPipeline = startTranscriptionPipeline;',
  ].join('\n');
  vm.runInContext(script, context);
  return { context, buffers, order, retryQueues };
}

test('H3: live audio cannot overtake buffered startup audio on any channel', async () => {
  const harness = createReplayHarness();

  await harness.context.startTranscriptionPipeline();
  // Replay yields through setImmediate; give it a few turns to finish.
  for (let attempt = 0; attempt < 50 && harness.context.transcriptionMode !== 'local-stream'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const themOld = harness.order.indexOf('them:them-old');
  const themLive = harness.order.indexOf('them:them-live');
  assert.ok(themOld >= 0, 'the buffered channel was replayed');
  assert.ok(themLive >= 0, `live audio was eventually delivered: ${harness.order.join(',')}`);
  assert.ok(themOld < themLive, 'older system audio must reach the worker first');
  assert.equal(harness.context.replayingChannels.size, 0, 'every channel is released after both passes');
});

test('M2: the stream lease is refreshed on a timer and cleared when capture stops', async () => {
  const source = sourceBlock('function stopLocalSpeechLeaseRefresh(', 'async function stopTranscriptionPipeline(');
  const context = vm.createContext({
    setInterval,
    clearInterval,
    LOCAL_SPEECH_LEASE_REFRESH_MS: 3000,
    localSpeechLeaseTimer: null,
    localSpeechStreamManager: null,
    state: { capturing: true },
  });
  vm.runInContext(`${source}
globalThis.startRefresh = startLocalSpeechLeaseRefresh;
globalThis.stopRefresh = stopLocalSpeechLeaseRefresh;`, context);

  const beats = { you: 0, them: 0 };
  const manager = {
    channels: ['you', 'them'],
    heartbeat(channel) { beats[channel] += 1; return true; },
  };
  context.localSpeechStreamManager = manager;
  context.startRefresh(manager, 10);
  // A loaded CI runner can miss a fixed sleep, so wait for the condition
  // instead of assuming two 10 ms ticks fit inside 45 ms.
  const deadline = Date.now() + 1000;
  while ((beats.you < 2 || beats.them < 2) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(beats.you >= 2, 'the microphone lease is refreshed without new PCM');
  assert.ok(beats.them >= 2, 'the system channel is refreshed too');

  context.state.capturing = false;
  const afterStop = { ...beats };
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(beats, afterStop, 'the timer stops once capture ends');
  assert.equal(context.localSpeechLeaseTimer, null);

  context.state.capturing = true;
  context.startRefresh(manager, 10);
  context.stopRefresh();
  const afterExplicit = { ...beats };
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(beats, afterExplicit, 'teardown clears the timer explicitly');
});

test('H2 privacy: offline-unavailable has no cloud capture and a clear message', () => {
  const pipeline = sourceBlock('async function startTranscriptionPipeline()', 'async function stopTranscriptionPipeline(');
  const offlineBranch = pipeline.indexOf("transcriptionRoute === 'offline-unavailable'");
  const realtimeBranch = pipeline.indexOf("transcription.mode === 'realtime' && realtime.ready");
  assert.ok(offlineBranch >= 0, 'the distinct route is handled');
  assert.ok(realtimeBranch > offlineBranch, 'offline-unavailable is decided before any cloud session');
  assert.match(pipeline.slice(offlineBranch), /No audio was uploaded/);
  assert.match(pipeline.slice(offlineBranch), /mode: 'offline-unavailable'/);

  const route = sourceBlock('function routePcm(', 'function processMicrophonePcm(');
  const drop = route.indexOf("transcriptionMode === 'offline-unavailable'");
  const bufferPush = route.indexOf('buffers[channel].push(pcm)');
  assert.ok(drop >= 0 && drop < bufferPush, 'audio is discarded instead of buffered for an upload');
});
