'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  WhisperSidecar,
  MODEL_SPECS,
  PROVISIONED_BINARY_VERSION,
  buildInferenceBody,
  buildServerArgs,
  defaultBinariesDir,
  resolveWhisperBinary,
} = require('../src/whisper-sidecar');
const { RELEASE_VERSION } = require('../src/whisper-runtime-manifest');

// A minimal stand-in for a spawned ChildProcess: the sidecar only reads stderr,
// listens for exit/error and kills it.
function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test('WhisperSidecar constructs without throwing and starts not running', () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  assert.equal(sidecar.running, false);
  assert.equal(sidecar.state, null);
  assert.equal(sidecar.modelId, 'tiny');
});

test('WhisperSidecar stores a normalized language option', () => {
  assert.equal(new WhisperSidecar({ modelId: 'tiny', language: ' fr ' }).language, 'fr');
  assert.equal(new WhisperSidecar({ modelId: 'tiny', language: '' }).language, '');
  assert.equal(new WhisperSidecar({ modelId: 'tiny' }).language, '');
  assert.equal(new WhisperSidecar({ modelId: 'tiny', language: 'zh-TW' }).language, 'zh');
  assert.equal(new WhisperSidecar({ modelId: 'tiny', language: ' auto ' }).language, '');
});

test('WhisperSidecar.setLanguage updates the language for later transcriptions', () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny', language: 'fr' });
  assert.equal(sidecar.setLanguage('de').language, 'de');
  assert.equal(sidecar.setLanguage('zh-TW').language, 'zh');
  assert.equal(sidecar.setLanguage('auto').language, '');
  assert.equal(sidecar.setLanguage().language, '');
});

test('buildInferenceBody omits the language field when unset', () => {
  const { boundary, body } = buildInferenceBody(Buffer.from('RIFF-wav'));
  assert.ok(boundary.length > 0);
  assert.ok(body.includes(Buffer.from(`name="file"`)));
  assert.ok(!body.includes(Buffer.from(`name="language"`)), 'no language part when unset');
  assert.ok(body.toString('utf8').trim().endsWith(`--${boundary}--`));
});

test('buildInferenceBody includes a language form field when set', () => {
  const { boundary, body } = buildInferenceBody(Buffer.from('RIFF-wav'), 'es');
  const text = body.toString('utf8');
  assert.match(text, new RegExp(`name="language"\\r\\n\\r\\nes\\r\\n--${boundary}\\r\\n`));
});

test('buildInferenceBody normalizes locale-form and auto language codes', () => {
  const withZhTw = buildInferenceBody(Buffer.from('RIFF-wav'), 'zh-TW');
  assert.match(withZhTw.body.toString('utf8'), new RegExp('name="language"\\r\\n\\r\\nzh\\r\\n'));
  assert.ok(!withZhTw.body.toString('utf8').includes('zh-TW'), 'locale-form code must not reach whisper.cpp');
  const withAuto = buildInferenceBody(Buffer.from('RIFF-wav'), 'auto');
  assert.ok(!withAuto.body.includes(Buffer.from(`name="language"`)), 'auto must be omitted (auto-detect)');
});

test('running is a boolean derived from state; idle leaves it restartable', () => {
  const states = [];
  const sidecar = new WhisperSidecar({ modelId: 'tiny', onstate: (state) => states.push(state) });
  sidecar._setState('starting');
  assert.equal(sidecar.state, 'starting');
  assert.equal(sidecar.running, true);
  sidecar._setState('ready');
  assert.equal(sidecar.state, 'ready');
  assert.equal(sidecar.running, true);
  assert.deepEqual(states, ['starting', 'ready']);
  sidecar._setState('idle');
  assert.equal(sidecar.state, 'idle');
  assert.equal(sidecar.running, false, 'idle must allow a later start()');
});

test('queueYou and queueThem resolve with the transcript produced by _transcribe', async () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  sidecar._transcribe = async (pcm, channel) => `${channel}:${pcm.length}`;
  const you = await sidecar.queueYou(Buffer.from('hello you'));
  const them = await sidecar.queueThem(Buffer.from('hello them'));
  assert.equal(you.text, 'you:9');
  assert.equal(you.channel, 'you');
  assert.equal(typeof you.timestamp, 'number');
  assert.equal(them.text, 'them:10');
  assert.equal(them.channel, 'them');
});

test('queued audio keeps the language it was enqueued under', async () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny', language: 'fr' });
  const languages = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstCall = true;
  sidecar._transcribe = async (pcm, channel, language) => {
    languages.push(language);
    if (firstCall) {
      firstCall = false;
      await gate;
    }
    return `${channel}:${language}`;
  };
  const first = sidecar.queueYou(Buffer.from('a'));
  const second = sidecar.queueYou(Buffer.from('b'), 'de');
  sidecar.setLanguage('es');
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.text, 'you:fr', 'audio enqueued under fr must not be re-transcribed as es');
  assert.equal(secondResult.text, 'you:de', 'the per-job language must win over a later setLanguage');
});

test('queueYou rejects and the queue continues when _transcribe fails', async () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  let calls = 0;
  sidecar._transcribe = async () => {
    calls += 1;
    if (calls === 1) throw new Error('transcribe failed');
    return 'recovered';
  };
  const first = sidecar.queueYou(Buffer.from('a'));
  const second = sidecar.queueYou(Buffer.from('b'));
  await assert.rejects(first, /transcribe failed/);
  const recovered = await second;
  assert.equal(recovered.text, 'recovered');
  assert.equal(recovered.channel, 'you');
});

test('child exit invalidates the instance so a replacement can be started', () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  const child = new EventEmitter();
  sidecar.child = child;
  sidecar._setState('ready');
  sidecar._watchChild(child);
  child.emit('exit', 1, null);
  assert.equal(sidecar.running, false);
  assert.equal(sidecar.state, 'idle');
  assert.equal(sidecar.child, null, 'the dead child handle is cleared');
});

test('a spawn error invalidates the instance', () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  const child = new EventEmitter();
  sidecar.child = child;
  sidecar._setState('starting');
  sidecar._watchChild(child);
  child.emit('error', new Error('ENOENT'));
  assert.equal(sidecar.running, false);
  assert.equal(sidecar.child, null);
});

test('an exited child from a previous start does not clobber a newer child', () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  const first = new EventEmitter();
  const second = new EventEmitter();
  sidecar.child = second;
  sidecar._setState('ready');
  sidecar._watchChild(first);
  first.emit('exit', 1, null);
  assert.equal(sidecar.child, second, 'the newer child handle is preserved');
});

test('resolveWhisperBinary returns the VOLYX_LENS_WHISPER_SIDECAR_BIN path when executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-wsp-'));
  try {
    const binary = path.join(dir, 'whisper-server');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0', { mode: 0o755 });
    const resolved = resolveWhisperBinary({ env: { VOLYX_LENS_WHISPER_SIDECAR_BIN: binary } });
    assert.equal(resolved.binary, binary);
    assert.equal(resolved.source, 'VOLYX_LENS_WHISPER_SIDECAR_BIN');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWhisperBinary falls back to a bundled resources binary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-wsp-'));
  try {
    const resourcesPath = path.join(dir, 'Resources');
    const nativeDir = path.join(resourcesPath, 'native');
    fs.mkdirSync(nativeDir, { recursive: true });
    const binary = path.join(nativeDir, 'whisper-server');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0', { mode: 0o755 });
    const resolved = resolveWhisperBinary({ env: {}, resourcesPath, platform: 'darwin' });
    assert.equal(resolved.binary, binary);
    assert.equal(resolved.source, 'bundled resources');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWhisperBinary uses whisper-server.exe on win32 and skips the exec-bit check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-wsp-'));
  try {
    const resourcesPath = path.join(dir, 'Resources');
    const nativeDir = path.join(resourcesPath, 'native');
    fs.mkdirSync(nativeDir, { recursive: true });
    const binary = path.join(nativeDir, 'whisper-server.exe');
    fs.writeFileSync(binary, 'MZ', { mode: 0o644 });
    const resolved = resolveWhisperBinary({ env: {}, resourcesPath, platform: 'win32' });
    assert.equal(path.basename(resolved.binary), 'whisper-server.exe');
    assert.equal(resolved.source, 'bundled resources');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWhisperBinary prefers the env binary over bundled resources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-wsp-'));
  try {
    const fromEnv = path.join(dir, 'env-server');
    fs.writeFileSync(fromEnv, '#!/bin/sh\nexit 0', { mode: 0o755 });
    const resourcesPath = path.join(dir, 'Resources');
    const nativeDir = path.join(resourcesPath, 'native');
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, 'whisper-server'), '#!/bin/sh\nexit 0', { mode: 0o755 });
    const resolved = resolveWhisperBinary({ env: { VOLYX_LENS_WHISPER_SIDECAR_BIN: fromEnv }, resourcesPath, platform: 'darwin' });
    assert.equal(resolved.binary, fromEnv);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWhisperBinary finds a runtime-provisioned binary in the whisper-binaries dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-wsp-'));
  try {
    const binariesDir = path.join(dir, 'whisper-binaries', 'v1.9.2');
    fs.mkdirSync(binariesDir, { recursive: true });
    const binary = path.join(binariesDir, 'whisper-server');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0', { mode: 0o755 });
    const resolved = resolveWhisperBinary({ env: {}, binariesDir, platform: 'darwin' });
    assert.equal(resolved.binary, binary);
    assert.equal(resolved.source, 'provisioned binaries');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWhisperBinary prefers env, then provisioned, then bundled resources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-wsp-'));
  try {
    const fromEnv = path.join(dir, 'env-server');
    fs.writeFileSync(fromEnv, '#!/bin/sh\nexit 0', { mode: 0o755 });
    const binariesDir = path.join(dir, 'whisper-binaries', 'v1.9.2');
    fs.mkdirSync(binariesDir, { recursive: true });
    fs.writeFileSync(path.join(binariesDir, 'whisper-server'), '#!/bin/sh\nexit 0', { mode: 0o755 });
    const resourcesPath = path.join(dir, 'Resources');
    const nativeDir = path.join(resourcesPath, 'native');
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, 'whisper-server'), '#!/bin/sh\nexit 0', { mode: 0o755 });

    const envFirst = resolveWhisperBinary({ env: { VOLYX_LENS_WHISPER_SIDECAR_BIN: fromEnv }, binariesDir, resourcesPath, platform: 'darwin' });
    assert.equal(envFirst.binary, fromEnv);

    const provisionedSecond = resolveWhisperBinary({ env: {}, binariesDir, resourcesPath, platform: 'darwin' });
    assert.equal(provisionedSecond.source, 'provisioned binaries');

    const bundledLast = resolveWhisperBinary({ env: {}, binariesDir: '', resourcesPath, platform: 'darwin' });
    assert.equal(bundledLast.source, 'bundled resources');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWhisperBinary ignores a non-executable env path and falls back to bundled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-wsp-'));
  try {
    const fromEnv = path.join(dir, 'not-exec');
    // Windows has no exec bit, so a missing candidate is the portable way to
    // prove the fallback; on POSIX also prove a non-executable file is skipped.
    if (process.platform !== 'win32') fs.writeFileSync(fromEnv, 'not executable', { mode: 0o600 });
    const resourcesPath = path.join(dir, 'Resources');
    const nativeDir = path.join(resourcesPath, 'native');
    fs.mkdirSync(nativeDir, { recursive: true });
    const bundled = path.join(nativeDir, 'whisper-server');
    fs.writeFileSync(bundled, '#!/bin/sh\nexit 0', { mode: 0o755 });
    const resolved = resolveWhisperBinary({ env: { VOLYX_LENS_WHISPER_SIDECAR_BIN: fromEnv }, resourcesPath, platform: 'darwin' });
    assert.equal(resolved.binary, bundled);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveWhisperBinary throws an actionable error when no binary exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-wsp-'));
  try {
    const resourcesPath = path.join(dir, 'Resources');
    fs.mkdirSync(resourcesPath, { recursive: true });
    assert.throws(
      () => resolveWhisperBinary({ env: {}, resourcesPath, platform: 'darwin' }),
      /Whisper sidecar binary not found.*VOLYX_LENS_WHISPER_SIDECAR_BIN/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildServerArgs emits only options the pinned whisper-server accepts', () => {
  const args = buildServerArgs({ modelPath: '/models/ggml-base.en.bin', host: '127.0.0.1', port: 51234, threads: 4 });
  assert.deepEqual(args, [
    '-m', '/models/ggml-base.en.bin',
    '--host', '127.0.0.1',
    '--port', '51234',
    '--threads', '4',
  ]);
  // v1.9.5 has no --temp option; temperature belongs in the request body. Any
  // unknown flag makes the real server exit before /health is reachable.
  assert.ok(!args.includes('--temp'), '--temp is not a whisper-server flag');
  assert.ok(!args.some((arg) => /^--?temp(erature)?$/i.test(arg)), 'temperature is not a startup argument');
});

test('buildServerArgs rejects a missing model or invalid port', () => {
  assert.throws(() => buildServerArgs({ host: '127.0.0.1', port: 1 }), /modelPath/);
  assert.throws(() => buildServerArgs({ modelPath: '/m.bin', port: 0 }), /valid TCP port/);
  assert.throws(() => buildServerArgs({ modelPath: '/m.bin', port: 70000 }), /valid TCP port/);
});

test('buildInferenceBody sends temperature=0.0 as a form field', () => {
  const { boundary, body } = buildInferenceBody(Buffer.from('RIFF-wav'));
  const text = body.toString('utf8');
  assert.match(text, new RegExp(`name="temperature"\\r\\n\\r\\n0\\.0\\r\\n--${boundary}--`));
  assert.ok(body.includes(Buffer.from('name="file"')));
});

test('start() spawns with buildServerArgs output and no unsupported flag', async () => {
  const spawned = [];
  const child = fakeChild();
  const progress = [];
  const seenDownload = {};
  const sidecar = new WhisperSidecar({
    modelId: 'tiny',
    onDownloadProgress: (fraction) => progress.push(fraction),
    downloadModel: async (modelId, onProgress, options) => {
      seenDownload.modelId = modelId;
      seenDownload.onProgress = onProgress;
      seenDownload.signal = options.signal;
      onProgress(0.5);
      return { path: '/models/ggml-tiny.bin' };
    },
    resolveBinary: () => ({ binary: '/bin/whisper-server', source: 'test' }),
    spawn: (binary, args) => {
      spawned.push({ binary, args });
      return child;
    },
    fetchImpl: async (url) => ({ ok: url.endsWith('/health'), status: 200 }),
    sleep: async () => {},
  });

  await sidecar.start();

  assert.equal(sidecar.state, 'ready');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].binary, '/bin/whisper-server');
  assert.deepEqual(spawned[0].args, buildServerArgs({
    modelPath: '/models/ggml-tiny.bin',
    host: '127.0.0.1',
    port: sidecar.port,
    threads: 1,
  }));
  assert.ok(!spawned[0].args.includes('--temp'));
  assert.equal(seenDownload.modelId, 'tiny');
  assert.equal(typeof seenDownload.onProgress, 'function', 'the progress callback is forwarded to downloadModel');
  assert.ok(seenDownload.signal instanceof AbortSignal, 'the start token is passed to the download');
  assert.deepEqual(progress, [0.5]);
  await sidecar.stop();
});

test('_allocatePort reserves a TCP port, not a UDP one', async () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  const port = await sidecar._allocatePort();
  assert.ok(Number.isInteger(port) && port > 0);

  // Proven by binding the same TCP port: a UDP allocation could have returned a
  // port already held by a TCP listener, which is exactly the startup failure.
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'whisper-sidecar.js'), 'utf8');
  assert.doesNotMatch(source, /require\('dgram'\)/, 'no UDP socket is used to pick the HTTP port');
});

test('startupTimeoutMs defaults to 120s and the injected budget is enforced', async () => {
  assert.equal(new WhisperSidecar({ modelId: 'tiny' }).startupTimeoutMs, 120000);

  const child = fakeChild();
  let clock = 0;
  const sidecar = new WhisperSidecar({
    modelId: 'tiny',
    modelPath: '/models/ggml-tiny.bin',
    startupTimeoutMs: 1000,
    startupPollIntervalMs: 200,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async () => ({ ok: false, status: 503 }),
    resolveBinary: () => ({ binary: '/bin/whisper-server', source: 'test' }),
    spawn: () => child,
  });

  await assert.rejects(sidecar.start(), /did not become ready in time/);
  assert.equal(clock >= 1000, true, 'the configured deadline was consumed');
  assert.equal(child.killed, true, 'the child is killed when startup times out');
  assert.equal(sidecar.state, 'idle');
  assert.equal(sidecar.child, null);
});

test('stop() during the model download aborts it and never spawns', async () => {
  let spawnCalls = 0;
  let releaseDownload;
  let downloadSignal;
  const sidecar = new WhisperSidecar({
    modelId: 'large-v3',
    downloadModel: (modelId, onProgress, { signal }) => {
      downloadSignal = signal;
      return new Promise((resolve) => {
        releaseDownload = () => resolve({ path: '/models/ggml-large-v3.bin' });
        signal.addEventListener('abort', releaseDownload);
      });
    },
    resolveBinary: () => ({ binary: '/bin/whisper-server', source: 'test' }),
    spawn: () => { spawnCalls += 1; return fakeChild(); },
  });

  const starting = sidecar.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(downloadSignal, 'download started');
  assert.equal(downloadSignal.aborted, false);

  await sidecar.stop();
  assert.equal(downloadSignal.aborted, true, 'stop() cancels the download signal');
  await assert.rejects(starting, /aborted/);
  assert.equal(spawnCalls, 0, 'a cancelled start must not spawn a child');
  assert.equal(sidecar.child, null);
});

test('a download that resolves after stop() is still refused before spawn', async () => {
  let spawnCalls = 0;
  let resolveDownload;
  const sidecar = new WhisperSidecar({
    modelId: 'large-v3',
    downloadModel: () => new Promise((resolve) => { resolveDownload = () => resolve({ path: '/models/ggml-large-v3.bin' }); }),
    resolveBinary: () => ({ binary: '/bin/whisper-server', source: 'test' }),
    spawn: () => { spawnCalls += 1; return fakeChild(); },
  });

  const starting = sidecar.start();
  await new Promise((resolve) => setImmediate(resolve));
  await sidecar.stop();
  resolveDownload();
  await assert.rejects(starting, /aborted/);
  assert.equal(spawnCalls, 0, 'the post-download token check prevents a late spawn');
});

test('stop() during startup health polling kills the child and rejects', async () => {
  const child = fakeChild();
  let releaseSleep;
  const sidecar = new WhisperSidecar({
    modelId: 'tiny',
    modelPath: '/models/ggml-tiny.bin',
    resolveBinary: () => ({ binary: '/bin/whisper-server', source: 'test' }),
    spawn: () => child,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    sleep: () => new Promise((resolve) => { releaseSleep = resolve; }),
  });

  const starting = sidecar.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sidecar.state, 'starting');
  await sidecar.stop();
  assert.equal(child.killed, true, 'the spawned child is killed');
  releaseSleep();
  await assert.rejects(starting, /aborted/);
  assert.equal(sidecar.state, 'idle');
});

test('stop() aborts the active inference request and clears the controller', async () => {
  const sidecar = new WhisperSidecar({
    modelId: 'tiny',
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  sidecar.modelPath = '/models/ggml-tiny.bin';

  const inference = sidecar._transcribe(Buffer.from('RIFF-wav'), 'you', 'en');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sidecar.abortCtrl, 'the active inference controller is tracked');

  await sidecar.stop();
  await assert.rejects(inference, { name: 'AbortError' });
  assert.equal(sidecar.abortCtrl, null, 'the controller is cleared after the abort');
});

test('PROVISIONED_BINARY_VERSION tracks the pinned runtime release', () => {
  assert.equal(PROVISIONED_BINARY_VERSION, RELEASE_VERSION);
  assert.match(PROVISIONED_BINARY_VERSION, /^v\d+\.\d+\.\d+$/);
  assert.equal(defaultBinariesDir('/tmp/userData'), path.join('/tmp/userData', 'whisper-binaries', RELEASE_VERSION));
});

test('MODEL_SPECS describes quantized multilingual files honestly', () => {
  for (const id of ['tiny.int8', 'base.int8', 'small.int8', 'medium.int8', 'large-v3.int8']) {
    assert.match(MODEL_SPECS[id].desc, /multilingual/i, `${id} points at a multilingual file`);
    assert.doesNotMatch(MODEL_SPECS[id].desc, /english-only/i, `${id} must not claim to be English-only`);
  }
  assert.match(MODEL_SPECS.tiny.desc, /multilingual/i, 'ggml-tiny.bin is multilingual');
  // Only the .en ids are English-only in the whisper.cpp catalog.
  for (const [id, spec] of Object.entries(MODEL_SPECS)) {
    if (!id.endsWith('.en')) assert.doesNotMatch(spec.desc, /english-only/i, `${id} is not English-only`);
  }
});

test('concurrent start() calls share one startup and one child', async () => {
  let downloads = 0;
  let spawns = 0;
  const child = fakeChild();
  const sidecar = new WhisperSidecar({
    modelId: 'tiny',
    downloadModel: async () => { downloads += 1; return { path: '/models/ggml-tiny.bin' }; },
    resolveBinary: () => ({ binary: '/bin/whisper-server', source: 'test' }),
    spawn: () => { spawns += 1; return child; },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    sleep: async () => {},
  });
  const first = sidecar.start();
  const second = sidecar.start();
  assert.equal(first, second, 'the second call joins the first startup');
  await first;
  assert.equal(downloads, 1);
  assert.equal(spawns, 1);
  await sidecar.stop();
});

test('a missing model path can be injected without a network download', async () => {
  let downloads = 0;
  const child = fakeChild();
  const sidecar = new WhisperSidecar({
    modelId: 'tiny',
    modelPath: '/models/ggml-tiny.bin',
    downloadModel: async () => { downloads += 1; return { path: '/wrong.bin' }; },
    resolveBinary: () => ({ binary: '/bin/whisper-server', source: 'test' }),
    spawn: () => child,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  await sidecar.start();
  assert.equal(downloads, 0);
  assert.equal(sidecar.state, 'ready');
  await sidecar.stop();
});

test('a child that exits during startup rejects promptly with its exit code', async () => {
  const child = fakeChild();
  const sidecar = new WhisperSidecar({
    modelId: 'tiny',
    modelPath: '/models/ggml-missing.bin',
    resolveBinary: () => ({ binary: '/bin/whisper-server', source: 'test' }),
    spawn: () => {
      setImmediate(() => child.emit('exit', 3, null));
      return child;
    },
    fetchImpl: async () => ({ ok: false, status: 503 }),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 50)),
  });
  const started = Date.now();
  await assert.rejects(sidecar.start(), /exited with code 3/);
  assert.ok(Date.now() - started < 1000, 'startup does not wait for the full timeout');
  assert.equal(sidecar.state, 'idle');
});
