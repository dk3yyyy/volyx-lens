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
  assert.equal(recorder.snapshot().durationMs, 0);
});

test('an over-limit recording releases its buffered prefix instead of retaining it until Stop', () => {
  const recorder = createDiarizationRecorder({ recordingId: 'run-overflow', sampleRate: 24000, maxMinutes: 1 / 60 });
  assert.equal(recorder.append(Buffer.alloc(24000, 5)), true);
  assert.equal(recorder.append(Buffer.alloc(24000, 6)), true);
  assert.equal(recorder.bytes, 48000);
  assert.ok(recorder.snapshot().pcm.some((byte) => byte !== 0), 'a within-bound prefix is retained');

  assert.equal(recorder.append(Buffer.alloc(2, 7)), false, 'crossing the bound refuses the chunk');
  assert.equal(recorder.truncated, true, 'the overflow flag is sticky');
  assert.equal(recorder.bytes, 0, 'the unusable prefix is released');
  assert.equal(recorder.durationMs, 0);
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.bytes, 0, 'the snapshot reports what is actually retained');
  assert.equal(snapshot.durationMs, 0);
  assert.equal(snapshot.pcm.length, 0);
  assert.equal(snapshot.truncated, true);

  // Later chunks are still refused, and the recorder never resumes buffering.
  assert.equal(recorder.append(Buffer.alloc(24000, 8)), false);
  assert.equal(recorder.snapshot().pcm.length, 0);
  assert.equal(recorder.snapshot().truncated, true);
});

test('non-PCM input is rejected without tripping the retention limit', () => {
  const recorder = createDiarizationRecorder({ recordingId: 'run-invalid', sampleRate: 24000, maxMinutes: 5 });
  for (const chunk of ['not pcm', new Uint8Array(4), null, undefined, Buffer.from([1, 2, 3]), Buffer.alloc(0)]) {
    assert.equal(recorder.append(chunk), false);
    assert.equal(recorder.truncated, false, 'a bad type is not a retention overflow');
  }
  assert.equal(recorder.bytes, 0, 'non-PCM bytes are never counted');
  assert.equal(recorder.durationMs, 0);
  assert.equal(recorder.append(Buffer.alloc(2400, 7)), true);
  assert.equal(recorder.bytes, 2400);
  assert.equal(recorder.truncated, false);
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
