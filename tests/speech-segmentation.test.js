'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapVadSegments } = require('../src/speech-segmentation');

test('VAD sample ranges map from 16 kHz detector time to 24 kHz PCM byte offsets', () => {
  const pcm = Buffer.alloc(24000 * 2 * 3);
  const ranges = mapVadSegments(pcm, [
    { startSample: 16000, endSample: 32000 },
  ], { inputSampleRate: 24000, vadSampleRate: 16000, paddingMs: 0 });
  assert.deepEqual(ranges, [{ startByte: 48000, endByte: 96000, startMs: 1000, endMs: 2000 }]);
});

test('VAD segmentation clamps padding and merges overlapping ranges', () => {
  const pcm = Buffer.alloc(24000 * 2 * 3);
  const ranges = mapVadSegments(pcm, [
    { startSample: 8000, endSample: 16000 },
    { startSample: 15000, endSample: 24000 },
  ], { inputSampleRate: 24000, vadSampleRate: 16000, paddingMs: 100 });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].startByte, 19200);
  assert.equal(ranges[0].endByte, 76800);
});

test('VAD segmentation ignores malformed and out-of-bounds ranges', () => {
  const pcm = Buffer.alloc(24000 * 2);
  assert.deepEqual(mapVadSegments(pcm, [
    null,
    { startSample: -1, endSample: 'bad' },
    { startSample: 999999, endSample: 1000000 },
  ]), []);
});
