const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  MAGIC, TYPE_EVENT, TYPE_PCM, parseFrames, validateSystemAudioHelper, createSystemAudioCapture,
} = require('../src/system-audio-capture');

function frame(type, payload, sequence) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(16);
  MAGIC.copy(header, 0);
  header.writeUInt8(1, 4);
  header.writeUInt8(type, 5);
  header.writeUInt16BE(0, 6);
  header.writeUInt32BE(body.length, 8);
  header.writeUInt32BE(sequence, 12);
  return Buffer.concat([header, body]);
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); };
  return child;
}

test('system-audio frame parser reassembles split frames and requires canonical ready format', () => {
  const ready = frame(TYPE_EVENT, { event: 'ready', format: { encoding: 's16le', sampleRate: 24000, channels: 1, frameSamples: 480 } }, 0);
  const pcm = frame(TYPE_PCM, Buffer.alloc(960, 7), 1);
  const state = { buffer: Buffer.alloc(0), lastSequence: null, ready: false };
  const events = [];
  const chunks = [];
  const handlers = { onEvent: (event) => { events.push(event); if (event.event === 'ready') state.ready = true; }, onPcm: (chunk) => chunks.push(chunk) };
  const data = Buffer.concat([ready, pcm]);
  parseFrames(state, data.subarray(0, 11), handlers);
  parseFrames(state, data.subarray(11, 100), handlers);
  parseFrames(state, data.subarray(100), handlers);
  assert.equal(events[0].event, 'ready');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 960);
  assert.ok(chunks[0].every((byte) => byte === 7));
});

test('system-audio frame parser fails closed on malformed, out-of-order, or pre-ready PCM', () => {
  const handlers = { onEvent() {}, onPcm() {} };
  assert.throws(() => parseFrames({ buffer: Buffer.alloc(0), lastSequence: null, ready: false }, frame(TYPE_PCM, Buffer.alloc(960), 0), handlers), /protocol_pcm/);
  const bad = frame(TYPE_EVENT, { event: 'starting' }, 2);
  const state = { buffer: Buffer.alloc(0), lastSequence: 0, ready: false };
  assert.throws(() => parseFrames(state, bad, handlers), /protocol_sequence/);
  assert.throws(() => parseFrames({ buffer: Buffer.alloc(0), lastSequence: null, ready: false }, Buffer.alloc(140000), handlers), /protocol_overflow/);
});

test('system-audio helper validation rejects missing and world-writable executables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-audio-'));
  const helper = path.join(dir, 'helper');
  assert.equal(validateSystemAudioHelper(helper, 'darwin').reason, 'helper_missing');
  fs.writeFileSync(helper, '#!/bin/sh\n');
  fs.chmodSync(helper, 0o777);
  assert.equal(validateSystemAudioHelper(helper, 'darwin').reason, 'unsafe_helper');
  fs.chmodSync(helper, 0o755);
  assert.equal(validateSystemAudioHelper(helper, 'darwin').ready, true);
});

test('controller accepts canonical PCM only after ready and reports unexpected exit once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-audio-'));
  const helper = path.join(dir, 'helper');
  fs.writeFileSync(helper, '#!/bin/sh\n'); fs.chmodSync(helper, 0o755);
  const child = fakeChild();
  const chunks = []; const states = []; const exits = [];
  const controller = createSystemAudioCapture({
    platform: 'darwin', helperPath: helper, spawnImpl: () => child,
    onPcm: (chunk) => chunks.push(chunk), onState: (state) => states.push(state), onUnexpectedExit: (event) => exits.push(event),
  });
  const starting = controller.start();
  child.stdout.write(frame(TYPE_EVENT, { event: 'starting', protocol: 1 }, 0));
  child.stdout.write(frame(TYPE_EVENT, { event: 'ready', format: { encoding: 's16le', sampleRate: 24000, channels: 1, frameSamples: 480 } }, 1));
  assert.deepEqual(await starting, { ok: true });
  child.stdout.write(frame(TYPE_PCM, Buffer.alloc(960, 3), 2));
  assert.equal(chunks.length, 1);
  child.emit('close', 2, null);
  assert.equal(exits.length, 1);
  assert.equal(states.at(-1).state, 'failed');
});

test('renderer keeps macOS system PCM out of the preload boundary', () => {
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  assert.match(main, /createSystemAudioCapture/);
  assert.match(main, /onPcm: \(pcm\) => acceptPcm\('them', pcm\)/);
  assert.ok((main.match(/systemAudioCapture\.stop\(\{ immediate: true \}\)/g) || []).length >= 4);
  assert.match(renderer, /volyxLens\.platform !== 'darwin'/);
  assert.match(preload, /platform: process\.platform/);
  const swift = fs.readFileSync(path.join(root, 'native', 'macos-system-audio.swift'), 'utf8');
  assert.match(swift, /bundleIdentifier == "ai\.volyx\.lens"/);
  assert.match(swift, /self\?\.stopped\.signal\(\)/);
});
