'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiarizationRecorder } = require('../src/diarization-session');

test('diarization recorder retains bounded system PCM and reports exact duration', () => {
  const recorder = createDiarizationRecorder({ recordingId: 'run-1', sampleRate: 24000, maxMinutes: 5 });
  assert.equal(recorder.append(Buffer.alloc(2400, 1)), true);
  assert.equal(recorder.append(Buffer.alloc(2400, 2)), true);
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.recordingId, 'run-1');
  assert.equal(snapshot.sampleRate, 24000);
  assert.equal(snapshot.durationMs, 100);
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(snapshot.pcm, Buffer.concat([Buffer.alloc(2400, 1), Buffer.alloc(2400, 2)]));
});

test('diarization recorder rejects malformed chunks and marks duration overflow without partial analysis', () => {
  const recorder = createDiarizationRecorder({ recordingId: 'run-2', sampleRate: 24000, maxMinutes: 1 / 60 });
  assert.equal(recorder.append(Buffer.from([1, 2, 3])), false);
  assert.equal(recorder.append(Buffer.alloc(24000)), true);
  assert.equal(recorder.append(Buffer.alloc(24000)), true);
  assert.equal(recorder.append(Buffer.alloc(24000)), false);
  assert.equal(recorder.truncated, true);
  assert.equal(recorder.snapshot().truncated, true);
  // Overflow is sticky: even a smaller chunk cannot resume a partial recording.
  assert.equal(recorder.append(Buffer.alloc(2)), false);
  assert.equal(recorder.snapshot().durationMs, 1000);
});

test('diarization recorder copies audio and clears all retained data', () => {
  const recorder = createDiarizationRecorder({ recordingId: 'run-3' });
  const chunk = Buffer.from([1, 0, 2, 0]);
  recorder.append(chunk);
  chunk.fill(0);
  assert.deepEqual(recorder.snapshot().pcm, Buffer.from([1, 0, 2, 0]));
  const retained = recorder.snapshot().pcm;
  recorder.clear();
  assert.equal(recorder.bytes, 0);
  assert.equal(recorder.durationMs, 0);
  assert.equal(recorder.truncated, false);
  assert.equal(recorder.snapshot().pcm.length, 0);
  // The snapshot was a copy; clearing the recorder does not reach into it.
  assert.deepEqual(retained, Buffer.from([1, 0, 2, 0]));
});

test('diarization recorder clamps retention between one second and ten minutes', () => {
  const short = createDiarizationRecorder({ recordingId: 'short', maxMinutes: 0 });
  assert.equal(short.maxBytes, Math.floor((1 / 60) * 60 * 24000 * 2));
  assert.equal(short.append(Buffer.alloc(short.maxBytes + 2)), false);

  const long = createDiarizationRecorder({ recordingId: 'long', maxMinutes: 60 });
  assert.equal(long.maxBytes, 10 * 60 * 24000 * 2);
  const fallback = createDiarizationRecorder({ recordingId: 'fallback', sampleRate: -1, maxMinutes: Number.NaN });
  assert.equal(fallback.sampleRate, 24000);
  assert.equal(fallback.maxBytes, 5 * 60 * 24000 * 2);
});

test('diarization recorder requires a bounded recording id', () => {
  assert.throws(() => createDiarizationRecorder(), TypeError);
  assert.throws(() => createDiarizationRecorder({ recordingId: '   ' }), TypeError);
  assert.throws(() => createDiarizationRecorder({ recordingId: 'x'.repeat(101) }), TypeError);
});
