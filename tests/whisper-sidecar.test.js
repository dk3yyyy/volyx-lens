'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WhisperSidecar, buildInferenceBody, resolveWhisperBinary } = require('../src/whisper-sidecar');

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
  assert.match(text, new RegExp(`name="language"\\r\\n\\r\\nes\\r\\n--${boundary}--`));
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
    fs.writeFileSync(fromEnv, 'not executable', { mode: 0o600 });
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
