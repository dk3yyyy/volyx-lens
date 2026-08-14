const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { validateOfflineConfig, runWhisperCli, transcribeOffline, cancelOfflineTranscriptions } = require('../src/offline-stt');
const { createSTT, resetSidecar } = require('../src/stt');

async function fixture() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'volyx-lens-offline-test-'));
  const executable = path.join(dir, 'whisper-cli');
  const model = path.join(dir, 'model.bin');
  await fs.promises.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.promises.writeFile(model, 'model');
  return { dir, executable, model, env: { VOLYX_LENS_WHISPER_CLI: executable, VOLYX_LENS_WHISPER_MODEL: model } };
}

test('offline configuration requires explicit absolute executable and model paths', async () => {
  assert.equal(validateOfflineConfig({}).ready, false);
  assert.equal(validateOfflineConfig({ VOLYX_LENS_WHISPER_CLI: 'whisper-cli', VOLYX_LENS_WHISPER_MODEL: 'model.bin' }).ready, false);
  const item = await fixture();
  try { assert.equal(validateOfflineConfig(item.env).ready, true); }
  finally { await fs.promises.rm(item.dir, { recursive: true, force: true }); }
});

test('offline whisper adapter uses no shell, streams audio over stdin (no audio file on disk), bounded output, and cleans up', async () => {
  const item = await fixture();
  let jobDirectory;
  let streamedToStdin = null;
  try {
    const text = await runWhisperCli({
      executable: item.executable,
      model: item.model,
      wav: Buffer.from('RIFF-test'),
      spawnImpl(executable, args, options) {
        assert.equal(executable, item.executable);
        assert.equal(options.shell, false);
        assert.equal(args[args.indexOf('-f') + 1], '-', 'audio should be streamed from stdin, never written to a file');
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdin.write = (buffer) => { streamedToStdin = buffer; };
        child.stdin.end = () => {};
        child.kill = () => child.emit('close', null, 'SIGKILL');
        const outputPrefix = args[args.indexOf('--output-file') + 1];
        jobDirectory = path.dirname(outputPrefix);
        assert.equal(fs.existsSync(path.join(jobDirectory, 'audio.wav')), false, 'no audio file should exist in the working directory');
        setImmediate(async () => {
          await fs.promises.writeFile(`${outputPrefix}.txt`, 'local transcript');
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.equal(text, 'local transcript');
    assert.equal(streamedToStdin && streamedToStdin.toString(), 'RIFF-test');
    assert.equal(fs.existsSync(jobDirectory), false);
  } finally { await fs.promises.rm(item.dir, { recursive: true, force: true }); }
});

test('enabled offline STT is attempted before online providers without exposing executable selection to renderer', async () => {
  const item = await fixture();
  try {
    const stt = createSTT({ transcription: { offlineEnabled: true }, apiKeys: {} }, {
      env: item.env,
      offlineTranscribe: async () => 'offline first',
    });
    assert.deepEqual(stt.providers, ['offline']);
    const result = await stt.transcribe(Buffer.alloc(4000, 1));
    assert.deepEqual(result, { text: 'offline first', provider: 'offline' });
  } finally { await fs.promises.rm(item.dir, { recursive: true, force: true }); }
});

test('offline mode never uploads audio unless cloud fallback is explicitly enabled', async () => {
  const disabledFallback = createSTT({ transcription: { offlineEnabled: true, offlineCloudFallback: false }, apiKeys: { openai: 'not-used' } }, { env: {} });
  assert.equal(disabledFallback.available, false);
  assert.deepEqual(disabledFallback.providers, []);
  const enabledFallback = createSTT({ transcription: { offlineEnabled: true, offlineCloudFallback: true }, apiKeys: { openai: 'configured' } }, { env: {} });
  assert.deepEqual(enabledFallback.providers, ['openai']);
});

test('offline server mode routes through one persistent session reused across jobs', async () => {
  cancelOfflineTranscriptions(); // clear any session state left by earlier tests
  const item = await fixture();
  let starts = 0;
  try {
    const serverEnv = { ...item.env, VOLYX_LENS_WHISPER_SERVER: item.executable };
    const fakeSession = {
      running: true,
      async start() { starts += 1; },
      async stop() {},
      async transcribe(wav, options) { return options.prompt ? 'with prompt' : 'no prompt'; },
    };
    const factory = () => fakeSession;
    const one = await transcribeOffline(Buffer.from('RIFF-test'), { env: serverEnv, prompt: 'nova-3', sessionFactory: factory });
    const two = await transcribeOffline(Buffer.from('RIFF-test'), { env: serverEnv, sessionFactory: factory });
    assert.equal(one, 'with prompt');
    assert.equal(two, 'no prompt');
    assert.equal(starts, 1, 'the persistent session is started once and reused');
  } finally { await fs.promises.rm(item.dir, { recursive: true, force: true }); }
});

test('cancelling offline transcription stops the persistent server session', async () => {
  cancelOfflineTranscriptions(); // clear any session state left by earlier tests
  const item = await fixture();
  let stopped = 0;
  try {
    const serverEnv = { ...item.env, VOLYX_LENS_WHISPER_SERVER: item.executable };
    const fakeSession = {
      running: true,
      async start() {},
      async stop() { stopped += 1; },
      async transcribe() { return 'x'; },
    };
    await transcribeOffline(Buffer.from('RIFF-test'), { env: serverEnv, sessionFactory: () => fakeSession });
    cancelOfflineTranscriptions();
    assert.equal(stopped, 1);
  } finally { await fs.promises.rm(item.dir, { recursive: true, force: true }); }
});

test('offline transcription children are cancelled on lifecycle shutdown', async () => {
  const item = await fixture();
  try {
    const pending = transcribeOffline(Buffer.from('RIFF-test'), {
      env: item.env,
      spawnImpl() {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = (signal) => { setImmediate(() => child.emit('close', null, signal)); return true; };
        return child;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    cancelOfflineTranscriptions();
    await assert.rejects(pending, (error) => error.code === 'offline_cancelled');
  } finally { await fs.promises.rm(item.dir, { recursive: true, force: true }); }
});

test('the whisper sidecar is strictly opt-in and takes no precedence on its own', () => {
  const noFlag = createSTT({ transcription: {}, apiKeys: {} }, { env: {} });
  assert.equal(noFlag.available, false);
  assert.deepEqual(noFlag.providers, []);
  const flagged = createSTT({ transcription: {}, apiKeys: {} }, { env: { VOLYX_LENS_WHISPER_SIDECAR: '1' } });
  assert.deepEqual(flagged.providers, ['sidecar']);
});

test('a failed sidecar startup resets the singleton so the next request retries', async () => {
  resetSidecar();
  let created = 0;
  const factory = () => {
    created += 1;
    if (created === 1) return { async start() { throw new Error('model download failed'); } };
    return {
      async start() {},
      async queueYou() { return { text: 'hello', channel: 'you', timestamp: 1 }; },
    };
  };
  try {
    const stt = createSTT({ transcription: {}, apiKeys: {} }, { env: { VOLYX_LENS_WHISPER_SIDECAR: '1' }, sidecarFactory: factory });
    const first = await stt.transcribe(Buffer.alloc(4000, 1));
    assert.equal(first.text, '');
    assert.equal(first.error && first.error.provider, 'sidecar');
    const second = await stt.transcribe(Buffer.alloc(4000, 1));
    assert.deepEqual(second, { text: 'hello', provider: 'sidecar' });
    assert.equal(created, 2, 'a fresh sidecar is created after the failed start');
  } finally {
    resetSidecar();
  }
});

test('concurrent requests share one in-flight startup and never queue against a failed instance', async () => {
  resetSidecar();
  let created = 0;
  let starts = 0;
  let failStartup;
  const factory = () => {
    created += 1;
    const instance = {
      async start() {
        starts += 1;
        if (created === 1) return new Promise((resolve, reject) => { failStartup = () => reject(new Error('health check failed')); });
        return undefined;
      },
      async queueYou() { return { text: `ok-${created}`, channel: 'you', timestamp: 1 }; },
    };
    return instance;
  };
  try {
    const stt = createSTT({ transcription: {}, apiKeys: {} }, { env: { VOLYX_LENS_WHISPER_SIDECAR: '1' }, sidecarFactory: factory });
    const one = stt.transcribe(Buffer.alloc(4000, 1));
    const two = stt.transcribe(Buffer.alloc(4000, 1));
    await new Promise((resolve) => setImmediate(resolve));
    failStartup();
    const [resultOne, resultTwo] = await Promise.all([one, two]);
    assert.equal(resultOne.text, '');
    assert.equal(resultTwo.text, '');
    assert.equal(starts, 1, 'concurrent requests share a single startup attempt');
    assert.equal(created, 1, 'no extra instance was created for the concurrent caller');
    const retry = await stt.transcribe(Buffer.alloc(4000, 1));
    assert.deepEqual(retry, { text: 'ok-2', provider: 'sidecar' });
    assert.equal(created, 2, 'a fresh instance retries after the shared startup fails');
  } finally {
    resetSidecar();
  }
});

test('a reset during pending sidecar startup invalidates and stops the stale worker', async () => {
  resetSidecar();
  let created = 0;
  let stopped = 0;
  const factory = () => {
    created += 1;
    return {
      running: false,
      async start() {
        await new Promise((resolve) => setTimeout(resolve, 30)); // pending startup
      },
      async stop() { stopped += 1; },
      async queueYou() { return { text: `stale-${created}`, channel: 'you', timestamp: 1 }; },
    };
  };
  try {
    const stt = createSTT({ transcription: { offlineEnabled: true, whisperModel: 'base.en' } }, { env: {}, sidecarFactory: factory });
    const pending = stt.transcribe(Buffer.alloc(4000, 1));
    setTimeout(() => resetSidecar(), 5); // reset while startup is in flight
    const result = await pending;
    assert.equal(result.text, '');
    assert.match(result.error && result.error.message, /reset during startup/);
    await new Promise((resolve) => setTimeout(resolve, 40)); // let stale start resolve
    assert.equal(stopped, 1, 'the stale worker is stopped, never published');
    assert.equal(created, 1, 'no replacement worker was created for the stale request');
  } finally {
    resetSidecar();
  }
});

test('a sidecar whose child exited is replaced on the next request', async () => {
  resetSidecar();
  let created = 0;
  const instances = [];
  const factory = () => {
    created += 1;
    const inst = {
      running: true,
      async start() {},
      async queueYou() { return { text: `ok-${created}`, channel: 'you', timestamp: 1 }; },
    };
    instances.push(inst);
    return inst;
  };
  try {
    const stt = createSTT({ transcription: {}, apiKeys: {} }, { env: { VOLYX_LENS_WHISPER_SIDECAR: '1' }, sidecarFactory: factory });
    assert.deepEqual(await stt.transcribe(Buffer.alloc(4000, 1)), { text: 'ok-1', provider: 'sidecar' });
    instances[0].running = false; // the whisper.cpp child exited
    const retry = await stt.transcribe(Buffer.alloc(4000, 1));
    assert.deepEqual(retry, { text: 'ok-2', provider: 'sidecar' });
    assert.equal(created, 2, 'a dead sidecar is replaced instead of reused');
  } finally {
    resetSidecar();
  }
});
