'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workerPath = require.resolve('../src/speech-worker');
let modelVerification = async () => true;

function loadSpeechWorkerModule() {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === './speech-model-registry' && parent && parent.filename === workerPath) {
      return {
        getModel: (id) => id === 'fake-gguf' ? {
          id: 'fake-gguf',
          name: 'Fake GGUF',
          runtime: 'transcribe-cpp',
        } : null,
        isInstalled: () => true,
        modelPaths: () => ({ model: '/tmp/fake-gguf.gguf' }),
        verifyModel: (...args) => modelVerification(...args),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[workerPath];
  try { return require(workerPath); }
  finally { Module._load = originalLoad; }
}

class FakeChild extends EventEmitter {
  constructor({ respond = true, runtimeFallback = false, failWarm = false } = {}) {
    super();
    this.respond = respond;
    this.runtimeFallback = runtimeFallback;
    this.failWarm = failWarm;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new EventEmitter();
    this.requests = [];
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.pid = 4242;
    this.stdin.write = (line, callback) => {
      const message = JSON.parse(String(line));
      this.requests.push(message);
      setImmediate(() => {
        if (!this.respond) return;
        if (message.command === 'load') {
          const fallback = message.backend === 'gpu' && !this.runtimeFallback;
          this.stdout.write(`${JSON.stringify({ id: message.id, ok: true, result: {
            modelId: 'fake-gguf',
            backend: this.runtimeFallback ? 'mtl0' : 'cpu',
            backendFallback: fallback,
            capabilities: { nativeSampleRate: 16000, languages: ['en'], languageDetection: false, maxAudioMs: 30000 },
          } })}\n`);
        } else if (message.command === 'hardware-info') {
          this.stdout.write(`${JSON.stringify({ id: message.id, ok: true, result: { devices: [{ name: 'CPU', kind: 'cpu' }], backends: [{ name: 'cpu', available: true }] } })}\n`);
        } else if (message.command === 'warm') {
          if (this.failWarm) {
            this.stdout.write(`${JSON.stringify({ id: message.id, ok: false, error: { code: 'model_warmup_failed', message: 'CPU retry failed' } })}\n`);
          } else {
            const result = this.runtimeFallback
              ? { warmed: true, backend: 'cpu', backendFallback: true }
              : { warmed: true };
            this.stdout.write(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
          }
        } else if (message.command === 'transcribe') {
          this.stdout.write(`${JSON.stringify({ id: message.id, ok: true, result: {
            text: 'transcript',
            language: 'en',
            segments: [{ t0Ms: 0, t1Ms: 500, text: 'transcript' }],
            durationMs: 1,
          } })}\n`);
        } else if (message.command === 'unload') {
          this.stdout.write(`${JSON.stringify({ id: message.id, ok: true, result: { unloaded: true, loaded: false } })}\n`);
        } else {
          this.stdout.write(`${JSON.stringify({ id: message.id, ok: true, result: {} })}\n`);
        }
      });
      if (callback) callback(null);
    };
    this.stdin.end = () => {};
  }

  kill() { this.killed = true; return true; }

  exit() {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}

function fixture({ hangFirst = false, modelOperationTimeoutMs = 120_000, runtimeFallback = false, failWarm = false } = {}) {
  const { createSpeechWorker } = loadSpeechWorkerModule();
  const children = [];
  const worker = createSpeechWorker({
    binaryPath: '/fake/volyx-speech-worker',
    stopTimeoutMs: 5,
    modelOperationTimeoutMs,
    spawnImpl: () => {
      const child = new FakeChild({ respond: !(hangFirst && children.length === 0), runtimeFallback, failWarm });
      children.push(child);
      return child;
    },
  });
  return { worker, children };
}

test('speech worker exposes only batch lifecycle and model operations', () => {
  const { worker } = fixture();
  assert.deepEqual(Object.keys(worker).sort(), [
    'activeBackend', 'activeBackendFallback', 'events', 'hardwareInfo', 'loadModel',
    'loadedModelId', 'pid', 'stop', 'transcribe', 'unloadModel', 'warmModel', 'warmedModelId',
  ]);
});

test('speech worker rejects replacement requests until stop teardown finishes', async () => {
  const { worker, children } = fixture();
  await worker.loadModel('fake-gguf');
  assert.equal(worker.pid, 4242);
  assert.equal(children.length, 1);

  const stopping = worker.stop();
  await assert.rejects(worker.loadModel('fake-gguf'), { code: 'speech_worker_stopping' });
  assert.equal(children.length, 1, 'no replacement process starts during teardown');

  await stopping;
  await worker.loadModel('fake-gguf');
  assert.equal(children.length, 2);
  await worker.stop();
});

test('a timed-out worker request kills the stuck child and permits a clean restart', async () => {
  const { worker, children } = fixture({ hangFirst: true, modelOperationTimeoutMs: 10 });
  await assert.rejects(worker.loadModel('fake-gguf'), { code: 'speech_worker_timeout' });
  assert.equal(children[0].killed, true);
  children[0].exit();
  await new Promise((resolve) => setImmediate(resolve));

  await worker.loadModel('fake-gguf');
  assert.equal(children.length, 2);
  await worker.stop();
});

test('worker stdin errors reject pending requests instead of crashing the process', async () => {
  const { worker, children } = fixture({ hangFirst: true });
  const loading = worker.loadModel('fake-gguf');
  await new Promise((resolve) => setImmediate(resolve));
  children[0].stdin.emit('error', new Error('EPIPE'));
  await assert.rejects(loading, { code: 'speech_worker_write_failed' });
  await worker.stop();
});

test('speech worker candidates use platform binary names and accept absolute overrides', () => {
  const { speechWorkerCandidates } = loadSpeechWorkerModule();
  assert.deepEqual(speechWorkerCandidates({
    env: { VOLYX_LENS_SPEECH_WORKER_BIN: '/usr/bin/true' },
    platform: 'linux',
    arch: 'x64',
    resourcesPath: '',
    projectDir: '/project',
  }), ['/usr/bin/true', '/project/native-bin/volyx-speech-worker']);
  assert.deepEqual(speechWorkerCandidates({
    env: {},
    platform: 'win32',
    arch: 'x64',
    resourcesPath: '/resources',
    projectDir: '/project',
  }), ['/resources/native/volyx-speech-worker.exe', '/project/native-bin/volyx-speech-worker.exe']);
  const relative = speechWorkerCandidates({
    env: { VOLYX_LENS_SPEECH_WORKER_BIN: 'relative/worker' },
    platform: 'darwin',
    arch: 'arm64',
    projectDir: '/project',
  });
  assert.equal(relative.includes('relative/worker'), false);
});

test('speech worker resolver accepts Windows executables without POSIX mode bits', () => {
  const { resolveSpeechWorkerBinary } = loadSpeechWorkerModule();
  const candidate = path.join('/resources', 'native', 'volyx-speech-worker.exe');
  const resolved = resolveSpeechWorkerBinary({
    env: {},
    platform: 'win32',
    arch: 'x64',
    resourcesPath: '/resources',
    projectDir: '/project',
    fsImpl: {
      statSync: () => ({ isFile: () => true, mode: 0o666 }),
      accessSync: () => {},
      realpathSync: () => candidate,
    },
  });
  assert.deepEqual(resolved, { available: true, path: candidate, reason: '' });
});

test('speech worker resolver rejects world-writable override binaries', () => {
  const { resolveSpeechWorkerBinary } = loadSpeechWorkerModule();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-worker-'));
  const binary = path.join(directory, 'worker');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.chmodSync(binary, 0o777);
  try {
    const resolved = resolveSpeechWorkerBinary({
      env: { VOLYX_LENS_SPEECH_WORKER_BIN: binary },
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: '',
      projectDir: directory,
    });
    assert.equal(resolved.available, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('speech worker verifies artifacts before loading and rejects corrupted models', async () => {
  const previous = modelVerification;
  modelVerification = async () => false;
  const { worker, children } = fixture();
  try {
    await assert.rejects(worker.loadModel('fake-gguf'), { code: 'speech_model_integrity_mismatch' });
    assert.equal(children.length, 0);
  } finally {
    modelVerification = previous;
    await worker.stop();
  }
});

test('speech worker reuses a loaded model when the backend preference is already satisfied', async () => {
  const { worker, children } = fixture();
  await worker.loadModel('fake-gguf', { backend: 'cpu' });
  await worker.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'fake-gguf', backend: 'cpu' });
  assert.equal(children[0].requests.filter((request) => request.command === 'load').length, 1);
  assert.equal(children[0].requests.filter((request) => request.command === 'warm').length, 1);
  await worker.stop();
});

test('speech worker reuses an Auto-selected CPU model on CPU-only systems', async () => {
  const { worker, children } = fixture();
  await worker.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'fake-gguf', backend: 'auto' });
  await worker.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'fake-gguf', backend: 'auto' });
  assert.equal(children[0].requests.filter((request) => request.command === 'load').length, 1);
  assert.equal(children[0].requests.filter((request) => request.command === 'warm').length, 1);
  await worker.stop();
});

test('speech worker remembers GPU fallback instead of retrying GPU for every utterance', async () => {
  const { worker, children } = fixture();
  const loaded = await worker.loadModel('fake-gguf', { backend: 'gpu' });
  assert.equal(loaded.backend, 'cpu');
  assert.equal(loaded.backendFallback, true);
  await worker.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'fake-gguf', backend: 'gpu' });
  assert.equal(children[0].requests.filter((request) => request.command === 'load').length, 1);
  await worker.stop();
});

test('speech worker records a GPU out-of-memory fallback during warm-up', async () => {
  const { worker, children } = fixture({ runtimeFallback: true });
  await worker.loadModel('fake-gguf', { backend: 'gpu' });
  assert.equal(worker.activeBackend, 'mtl0');
  await worker.warmModel('fake-gguf', { backend: 'gpu' });
  assert.equal(worker.activeBackend, 'cpu');
  assert.equal(worker.activeBackendFallback, true);
  await worker.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'fake-gguf', backend: 'gpu' });
  assert.equal(children[0].requests.filter((request) => request.command === 'load').length, 1);
  await worker.stop();
});

test('speech worker clears stale loaded state when warm-up fails after a native unload', async () => {
  const { worker, children } = fixture({ failWarm: true });
  await worker.loadModel('fake-gguf', { backend: 'gpu' });
  await assert.rejects(worker.warmModel('fake-gguf', { backend: 'gpu' }), { code: 'model_warmup_failed' });
  assert.equal(worker.loadedModelId, '');
  assert.equal(worker.activeBackend, '');
  assert.equal(children[0].requests.some((request) => request.command === 'unload'), true);
  await assert.rejects(worker.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'fake-gguf', backend: 'gpu' }), { code: 'model_warmup_failed' });
  assert.equal(children[0].requests.filter((request) => request.command === 'load').length, 2);
  await worker.stop();
});

test('speech worker reloads when a loaded CPU model must switch to GPU batch inference', async () => {
  const { worker, children } = fixture();
  await worker.loadModel('fake-gguf', { backend: 'cpu' });
  await worker.loadModel('fake-gguf', { backend: 'gpu' });
  const commands = children[0].requests.map((request) => request.command);
  assert.ok(commands.includes('unload'));
  assert.ok(commands.indexOf('unload') < commands.lastIndexOf('load'));
  assert.equal(children[0].requests.filter((request) => request.command === 'load').at(-1).backend, 'gpu');
  await worker.stop();
});

test('speech worker transcribes WAV batches, forwards language, and unloads explicitly', async () => {
  const { worker, children } = fixture();
  const result = await worker.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'fake-gguf', language: 'fr', backend: 'cpu' });
  assert.equal(result.text, 'transcript');
  assert.equal(result.provider, 'local-gguf');
  assert.equal(result.modelId, 'fake-gguf');
  const request = children[0].requests.find((entry) => entry.command === 'transcribe');
  assert.equal(request.language, 'fr');
  assert.equal(request.wavBase64, Buffer.from('RIFF-test').toString('base64'));
  assert.equal(worker.warmedModelId, 'fake-gguf');
  assert.deepEqual(await worker.unloadModel('fake-gguf'), { unloaded: true, loaded: false });
  assert.equal(worker.loadedModelId, '');
  assert.equal(worker.warmedModelId, '');
  await worker.stop();
});

test('speech worker rejects invalid batch inputs and unsupported models', async () => {
  const { worker, children } = fixture();
  await assert.rejects(worker.transcribe({ wav: 'not-a-buffer', modelId: 'fake-gguf' }), TypeError);
  await assert.rejects(worker.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'unknown' }), { code: 'speech_model_unsupported' });
  await assert.rejects(worker.loadModel('base.en'), { code: 'speech_model_unsupported' });
  assert.equal(children.length, 0);
  await worker.stop();
});

test('speech worker environment preserves Windows runtime variables without forwarding secrets', () => {
  const { speechWorkerEnvironment } = loadSpeechWorkerModule();
  const env = speechWorkerEnvironment({
    Path: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    SECRET_TOKEN: 'do-not-forward',
  });
  assert.equal(env.PATH, 'C:\\Windows\\System32');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.TEMP, 'C:\\Temp');
  assert.equal(env.SECRET_TOKEN, undefined);
});

test('speech worker forwards backend preference and reports hardware', async () => {
  const { worker, children } = fixture();
  await worker.loadModel('fake-gguf', { backend: 'cpu' });
  assert.equal(worker.activeBackend, 'cpu');
  assert.equal(children[0].requests.find((request) => request.command === 'load').backend, 'cpu');
  const hardware = await worker.hardwareInfo();
  assert.equal(hardware.devices[0].name, 'CPU');
  assert.equal(hardware.backends[0].available, true);
  await worker.stop();
});

test('a late exit from an old speech worker cannot destroy replacement model state', async () => {
  const { worker, children } = fixture();
  await worker.loadModel('fake-gguf');
  const oldChild = children[0];

  await worker.stop();
  await worker.loadModel('fake-gguf');
  const replacement = children[1];
  assert.equal(replacement.requests.some((request) => request.command === 'load'), true);

  oldChild.exit();
  assert.equal(worker.loadedModelId, 'fake-gguf');
  await worker.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'fake-gguf' });
  assert.equal(replacement.requests.some((request) => request.command === 'transcribe'), true);
  await worker.stop();
});
