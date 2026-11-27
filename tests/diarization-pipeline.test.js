'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDiarizationRecorder } = require('../src/diarization-session');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function sourceBlock(startMarker, endMarker) {
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `could not extract ${startMarker}`);
  return main.slice(start, end);
}

const diarizationSource = sourceBlock('function clearDiarizationRecorder()', 'async function applyCaptureState(active) {');

function createPipelineHarness(overrides = {}) {
  const settings = {
    transcription: {
      historyEnabled: true,
      speechBackend: 'auto',
      diarization: { enabled: true, preset: 'high_latency', maxMinutes: 5 },
      ...(overrides.transcription || {}),
    },
  };
  const state = { capturing: true };
  const events = [];
  const runs = [];
  const saved = [];
  const wavs = [];
  const calls = [];
  const worker = {
    loadedModelId: '',
    async unloadModel() { calls.push('unloadModel'); this.loadedModelId = ''; },
    async runDiarizer(options) {
      calls.push('runDiarizer');
      wavs.push(options.wav);
      if (overrides.runDiarizer) return overrides.runDiarizer(options, context);
      return { segments: [{ speakerId: 0, t0Ms: 0, t1Ms: 500 }] };
    },
    async unloadDiarizer() { calls.push('unloadDiarizer'); },
    async stop() { calls.push('stop'); },
  };
  const context = vm.createContext({
    Buffer,
    console: { warn() {}, error() {}, log() {} },
    AUDIO_SAMPLE_RATE: 24000,
    createDiarizationRecorder,
    pcmToWav: (pcm, rate, channels) => {
      const wav = Buffer.from(`WAV:${rate}:${channels}:${pcm.length}`);
      wavs.push(wav);
      return wav;
    },
    state,
    store: {
      getSettings: () => settings,
    },
    send: (channel, payload) => events.push({ channel, payload }),
    meetingStore: {
      updateDiarization: (recordId, run) => {
        saved.push({ recordId, run });
        return { updated: true, run };
      },
    },
    diarizationRuns: runs,
    defaultSpeechWorker: worker,
    isSpeechDiarizerInstalled: () => overrides.installed !== false,
    speechDiarizerInfo: () => ({ id: 'diar-test', sampleRate: 16000, artifact: { sha256: 'abc' } }),
  });
  vm.runInContext(`
    let diarizationRecorder = null;
    let diarizationRunConfig = null;
    let diarizationSequence = 0;
    let diarizationAnalysisGeneration = 0;
    let diarizationAnalysisActive = false;
    ${diarizationSource}
    globalThis.api = {
      startDiarizationRecorder,
      restartDiarizationRecorderForContinuedCapture,
      cancelDiarizationForHistoryChange,
      analyzeDiarization,
      clearDiarizationRecorder,
      arm(recorder, config) { diarizationRecorder = recorder; diarizationRunConfig = config; },
      get recorder() { return diarizationRecorder; },
      get generation() { return diarizationAnalysisGeneration; },
      get active() { return diarizationAnalysisActive; },
      bumpGeneration() { diarizationAnalysisGeneration += 1; },
    };
  `, context);
  return { api: context.api, settings, state, events, saved, calls, wavs, worker };
}

test('normal stop analyzes the Them recording and stores a ready run', async () => {
  const harness = createPipelineHarness();
  harness.api.startDiarizationRecorder({ systemEnabled: true });
  const recorder = harness.api.recorder;
  assert.ok(recorder, 'opt-in + history + system audio arms the recorder');
  assert.equal(recorder.recordingId.startsWith('diar-'), true);
  recorder.append(Buffer.alloc(48000, 7)); // one second at 24 kHz mono PCM16

  const run = await harness.api.analyzeDiarization('meeting-1');
  assert.equal(run.status, 'ready');
  assert.equal(run.sourceChannel, 'them');
  assert.equal(run.recordingId, recorder.recordingId);
  assert.equal(run.modelId, 'diar-test');
  assert.equal(run.preset, 'high_latency');
  assert.equal(run.sampleRate, 16000);
  assert.equal(run.durationMs, 1000);
  assert.deepEqual(run.segments, [{ speakerId: 0, t0Ms: 0, t1Ms: 500 }]);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0].recordId, 'meeting-1');
  assert.deepEqual(harness.calls, ['runDiarizer', 'unloadDiarizer']);
  assert.equal(harness.api.recorder, null, 'audio is detached after the run');
  assert.equal(harness.api.active, false);
  // The WAV handed to the worker is zeroed once analysis finishes.
  assert.ok(harness.wavs.every((wav) => wav.every((byte) => byte === 0)));
  assert.match(harness.events.at(-1).payload.message, /Speaker activity analyzed locally: 1/);
});

test('the recorder never arms without opt-in, history, or system audio', () => {
  for (const [label, overrides, audio] of [
    ['disabled', { transcription: { diarization: { enabled: false, preset: 'high_latency', maxMinutes: 5 } } }, { systemEnabled: true }],
    ['history off', { transcription: { historyEnabled: false } }, { systemEnabled: true }],
    ['system audio off', {}, { systemEnabled: false }],
  ]) {
    const harness = createPipelineHarness(overrides);
    harness.api.startDiarizationRecorder(audio);
    assert.equal(harness.api.recorder, null, label);
  }
});

test('over-limit and too-short recordings are reported without running the model', async () => {
  const truncated = createPipelineHarness({ transcription: { diarization: { enabled: true, preset: 'high_latency', maxMinutes: 1 / 60 } } });
  truncated.api.startDiarizationRecorder({ systemEnabled: true });
  truncated.api.recorder.append(Buffer.alloc(48000));
  truncated.api.recorder.append(Buffer.alloc(2));
  const truncatedRun = await truncated.api.analyzeDiarization('meeting-2');
  assert.equal(truncatedRun.status, 'unavailable');
  assert.equal(truncatedRun.reason, 'duration_limit_exceeded');
  assert.equal(truncated.calls.includes('runDiarizer'), false);

  const short = createPipelineHarness();
  short.api.startDiarizationRecorder({ systemEnabled: true });
  short.api.recorder.append(Buffer.alloc(4800));
  const shortRun = await short.api.analyzeDiarization('meeting-3');
  assert.equal(shortRun.reason, 'insufficient_system_audio');
  assert.equal(short.calls.includes('runDiarizer'), false);
});

test('a missing diarizer artifact records an unavailable run instead of failing the stop', async () => {
  const harness = createPipelineHarness({ installed: false });
  harness.api.startDiarizationRecorder({ systemEnabled: true });
  harness.api.recorder.append(Buffer.alloc(48000));
  const run = await harness.api.analyzeDiarization('meeting-4');
  assert.equal(run.status, 'unavailable');
  assert.equal(run.reason, 'diarizer_not_installed');
  assert.equal(harness.calls.includes('runDiarizer'), false);
  assert.equal(harness.calls.includes('unloadDiarizer'), true, 'the worker is always released');
});

test('a worker failure saves the transcript-adjacent run as failed and still releases the worker', async () => {
  const harness = createPipelineHarness({
    runDiarizer: async () => {
      const error = new Error('Speech worker exited.');
      error.code = 'speech_worker_exited';
      throw error;
    },
  });
  harness.api.startDiarizationRecorder({ systemEnabled: true });
  harness.api.recorder.append(Buffer.alloc(48000));
  const run = await harness.api.analyzeDiarization('meeting-5');
  assert.equal(run.status, 'failed');
  assert.equal(run.reason, 'speech_worker_exited');
  assert.equal(run.segments.length, 0);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.calls.includes('unloadDiarizer'), true);
});

test('a warm transcription model is released before the diarizer loads', async () => {
  const harness = createPipelineHarness();
  harness.worker.loadedModelId = 'parakeet';
  harness.api.startDiarizationRecorder({ systemEnabled: true });
  harness.api.recorder.append(Buffer.alloc(48000));
  await harness.api.analyzeDiarization('meeting-6');
  assert.deepEqual(harness.calls.slice(0, 3), ['unloadModel', 'runDiarizer', 'unloadDiarizer']);
});

test('history-off or New Session invalidates an in-flight analysis before persistence', async () => {
  const harness = createPipelineHarness({
    runDiarizer: async (_options, ctx) => {
      ctx.api.bumpGeneration();
      const error = new Error('Speaker diarization was canceled.');
      error.code = 'diarization_cancelled';
      throw error;
    },
  });
  harness.api.startDiarizationRecorder({ systemEnabled: true });
  harness.api.recorder.append(Buffer.alloc(48000));
  const run = await harness.api.analyzeDiarization('meeting-7');
  assert.equal(run, null, 'a canceled run is never persisted');
  assert.equal(harness.saved.length, 0);
});

test('history-off after analysis but before persistence also discards the run', async () => {
  const harness = createPipelineHarness({
    runDiarizer: async () => {
      harness.settings.transcription.historyEnabled = false;
      return { segments: [] };
    },
  });
  harness.api.startDiarizationRecorder({ systemEnabled: true });
  harness.api.recorder.append(Buffer.alloc(48000));
  const run = await harness.api.analyzeDiarization('meeting-8');
  assert.equal(run, null);
  assert.equal(harness.saved.length, 0);
});

test('New Session, Clear Transcript, and quit boundaries clear or re-arm the recorder', () => {
  const harness = createPipelineHarness();
  harness.api.startDiarizationRecorder({ systemEnabled: true });
  const first = harness.api.recorder;
  harness.api.cancelDiarizationForHistoryChange();
  assert.equal(harness.api.recorder, null);
  assert.equal(first.truncated, false);
  assert.equal(first.bytes, 0, 'cancelled audio is zeroed');

  harness.api.restartDiarizationRecorderForContinuedCapture();
  assert.notEqual(harness.api.recorder, null, 'continued capture gets a fresh recording');
  harness.state.capturing = false;
  harness.api.restartDiarizationRecorderForContinuedCapture();
  assert.equal(harness.api.recorder, null, 'a stop never re-arms recording');
});

test('preload exposes the diarizer bridge and a single progress allow-list entry', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const [method, channel] of [
    ['speechDiarizerGet', 'speech-diarizer:get'],
    ['speechDiarizerDownload', 'speech-diarizer:download'],
    ['speechDiarizerCancelDownload', 'speech-diarizer:cancel-download'],
    ['speechDiarizerRemove', 'speech-diarizer:remove'],
    ['speechDiarizerWarm', 'speech-diarizer:warm'],
    ['speechDiarizerUnload', 'speech-diarizer:unload'],
  ]) {
    assert.match(preload, new RegExp(`${method}: \\(\\) => ipcRenderer\\.invoke\\('${channel}'\\)`), method);
  }
  const allowList = preload.slice(preload.indexOf('const allowed = ['), preload.indexOf('];', preload.indexOf('const allowed = [')));
  assert.match(allowList, /'speech:diarizer-progress'/);
  assert.equal((allowList.match(/speech:diarizer-progress/g) || []).length, 1);
});
