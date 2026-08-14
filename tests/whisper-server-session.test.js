'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WhisperServerSession, findFreeLoopbackPort, buildInferenceBody } = require('../src/whisper-server-session');

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  // Like a real child process: a kill eventually produces a close event.
  child.kill = (signal) => {
    setImmediate(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

function sessionOptions(overrides = {}) {
  return {
    executable: '/bin/true',
    modelPath: '/tmp/model.bin',
    port: 9999,
    spawnImpl: () => fakeChild(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ text: 'ok' }) }),
    // Yield via a macrotask (like the production setTimeout delay) so the
    // health-poll loop does not starve setImmediate-scheduled child events.
    wait: () => new Promise((resolve) => setImmediate(resolve)),
    ...overrides,
  };
}

test('findFreeLoopbackPort returns a valid loopback port', async () => {
  const port = await findFreeLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
});

test('buildInferenceBody includes json format, zero temperature, language, and prompt', () => {
  const wav = Buffer.from('RIFF-test');
  const { boundary, body } = buildInferenceBody(wav, { language: 'en', prompt: 'nova-3, EKS' });
  const text = body.toString('utf8');
  assert.match(text, new RegExp(`--${boundary}`));
  assert.match(text, /name="response_format"\r\n\r\njson/);
  assert.match(text, /name="temperature"\r\n\r\n0\.0/);
  assert.match(text, /name="language"\r\n\r\nen/);
  assert.match(text, /name="prompt"\r\n\r\nnova-3, EKS/);
  assert.match(text, /filename="audio\.wav"/);
  assert.ok(body.includes(wav), 'raw WAV bytes are embedded');
});

test('buildInferenceBody omits the language field entirely for auto and empty values', () => {
  const wav = Buffer.from('RIFF-test');
  const withAuto = buildInferenceBody(wav, { language: 'auto' });
  assert.ok(!withAuto.body.toString('utf8').includes('name="language"'), 'auto must omit the field, not emit it empty');
  const withEmpty = buildInferenceBody(wav, { language: 'zh-TW' });
  const text = withEmpty.body.toString('utf8');
  assert.match(text, /name="language"\r\n\r\nzh/, 'locale-form codes are normalized to the base code');
  assert.ok(!text.includes('zh-TW'), 'locale-form code must not reach whisper.cpp');
});

test('start polls until the server is healthy, then reports ready', async () => {
  let calls = 0;
  const session = new WhisperServerSession(sessionOptions({
    spawnImpl: (executable, args) => {
      assert.equal(args[args.indexOf('--port') + 1], '9999');
      return fakeChild();
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 2) throw new Error('not up yet');
      return { ok: true };
    },
  }));
  await session.start();
  assert.equal(session.state, 'ready');
  assert.equal(session.running, true);
  assert.ok(calls >= 2);
  await session.stop();
});

test('start rejects with the stderr tail when the process exits during startup', async () => {
  const child = fakeChild();
  const session = new WhisperServerSession(sessionOptions({
    spawnImpl: () => child,
    fetchImpl: async () => { throw new Error('down'); },
  }));
  const starting = session.start();
  setImmediate(() => {
    child.stderr.emit('data', Buffer.from('fatal: cannot open model'));
    child.emit('close', 1);
  });
  await assert.rejects(starting, /fatal: cannot open model/);
  assert.equal(session.running, false);
});

test('transcribe posts a multipart body to /inference and returns the trimmed text', async () => {
  let captured = null;
  const session = new WhisperServerSession(sessionOptions({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ text: '  hello world\n' }) };
    },
  }));
  await session.start();
  const text = await session.transcribe(Buffer.from('RIFF'));
  assert.equal(text, 'hello world');
  assert.match(captured.url, /\/inference$/);
  assert.match(captured.options.headers['Content-Type'], /multipart\/form-data; boundary=/);
  assert.ok(Buffer.isBuffer(captured.options.body));
});

test('transcribe rejects whisper_session_lost and stops the session on connection failure', async () => {
  const session = new WhisperServerSession(sessionOptions({
    // Health checks must succeed; only the /inference POST fails.
    fetchImpl: async (url) => {
      if (url.endsWith('/inference')) throw new Error('ECONNREFUSED');
      return { ok: true };
    },
  }));
  await session.start();
  await assert.rejects(session.transcribe(Buffer.from('RIFF')), (error) => error.code === 'whisper_session_lost');
  assert.equal(session.running, false);
});

test('transcribe rejects whisper_http_error with the server status', async () => {
  const session = new WhisperServerSession(sessionOptions({
    fetchImpl: async (url) => {
      if (url.endsWith('/inference')) return { ok: false, status: 500 };
      return { ok: true };
    },
  }));
  await session.start();
  await assert.rejects(session.transcribe(Buffer.from('RIFF')), (error) => error.code === 'whisper_http_error' && error.status === 500);
});

test('stop escalates SIGTERM to SIGKILL and is idempotent', async () => {
  const signals = [];
  const child = fakeChild();
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null, 'SIGKILL'));
    return true;
  };
  const session = new WhisperServerSession(sessionOptions({ spawnImpl: () => child }));
  await session.start();
  await session.stop();
  await session.stop(); // second stop is a no-op
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('a crash while ready marks the session stopped so calls fail fast', async () => {
  const child = fakeChild();
  const session = new WhisperServerSession(sessionOptions({ spawnImpl: () => child }));
  await session.start();
  child.emit('close', 1);
  assert.equal(session.running, false);
});

test('stop resolves promptly after the child already exited (no hang)', async () => {
  const child = fakeChild();
  const session = new WhisperServerSession(sessionOptions({ spawnImpl: () => child }));
  await session.start();
  // A real child sets exitCode when it closes; stop() must not wait on a
  // 'close' event that has already fired.
  child.emit('close', 1);
  child.exitCode = 1;
  assert.equal(session.running, false);
  const t0 = Date.now();
  await session.stop();
  assert.ok(Date.now() - t0 < 5000, 'stop() must not hang on an already-exited child');
});

test('stop returns promptly when the child ignores SIGTERM and only dies on SIGKILL', async () => {
  let closed = false;
  const child = fakeChild();
  child.kill = (signal) => {
    if (signal === 'SIGKILL') setImmediate(() => { closed = true; child.emit('close', null, 'SIGKILL'); });
    return true;
  };
  const session = new WhisperServerSession(sessionOptions({ spawnImpl: () => child }));
  await session.start();
  const t0 = Date.now();
  await session.stop();
  assert.equal(closed, true);
  assert.ok(Date.now() - t0 < 5000, 'stop() must resolve even when the close never fires');
});
