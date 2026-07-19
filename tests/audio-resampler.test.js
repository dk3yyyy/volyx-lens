const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'renderer', 'audio-worklet.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const moduleStub = { exports: {} };
const context = {
  module: moduleStub,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
  registerProcessor() {},
  sampleRate: 48000,
  Float32Array,
  Int16Array,
  Math,
  Number,
};
vm.runInNewContext(source, context);
const { StreamingLinearResampler } = moduleStub.exports;

function resample(sourceRate, targetRate, seconds = 1) {
  const resampler = new StreamingLinearResampler(sourceRate, targetRate);
  const total = sourceRate * seconds;
  const output = [];
  for (let offset = 0; offset < total; offset += 128) {
    const length = Math.min(128, total - offset);
    const chunk = new Float32Array(length);
    for (let index = 0; index < length; index += 1) chunk[index] = Math.sin(2 * Math.PI * 440 * (offset + index) / sourceRate);
    output.push(...resampler.push(chunk));
  }
  return output;
}

test('streaming resampler converts 48 kHz and 44.1 kHz input to stable 24 kHz output', () => {
  for (const sourceRate of [48000, 44100]) {
    const output = resample(sourceRate, 24000);
    assert.ok(Math.abs(output.length - 24000) <= 2, `${sourceRate} produced ${output.length} samples`);
    assert.ok(output.every(Number.isFinite));
    assert.ok(Math.max(...output.map(Math.abs)) > 0.95);
  }
});

test('renderer measures the real AudioContext rate and asks the worklet for 24 kHz PCM', () => {
  assert.match(renderer, /const context = new AudioContext\(\)/);
  assert.match(renderer, /processorOptions: \{ targetSampleRate: AUDIO_SAMPLE_RATE \}/);
  assert.match(renderer, /sourceSampleRate/);
  assert.match(renderer, /Receiving · \$\{formatLabel\}/);
});
