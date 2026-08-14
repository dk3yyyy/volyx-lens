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

test('offline whisper adapter uses no shell, private temp files, bounded output, and cleans up', async () => {
  const item = await fixture();
  let jobDirectory;
  try {
    const text = await runWhisperCli({
      executable: item.executable,
      model: item.model,
      wav: Buffer.from('RIFF-test'),
      spawnImpl(executable, args, options) {
        assert.equal(executable, item.executable);
        assert.equal(options.shell, false);
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => child.emit('close', null, 'SIGKILL');
        const input = args[args.indexOf('-f') + 1];
        const outputPrefix = args[args.indexOf('--output-file') + 1];
        jobDirectory = path.dirname(input);
        assert.equal(fs.statSync(input).mode & 0o777, 0o600);
        setImmediate(async () => {
          await fs.promises.writeFile(`${outputPrefix}.txt`, 'local transcript');
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.equal(text, 'local transcript');
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
