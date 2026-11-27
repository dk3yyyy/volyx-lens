'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  audioDurationSeconds,
  median,
  summarizeBenchmark,
  checkBenchmarkThresholds,
  runBenchmark,
  processStats,
  parseArgs,
  printSummary,
} = require('../scripts/speech-benchmark');
const { pcmToWav } = require('../src/wav');

test('benchmark derives audio duration from mono 16-bit WAV data', () => {
  const pcm = Buffer.alloc(24000 * 2);
  assert.equal(audioDurationSeconds(pcmToWav(pcm, 24000, 1)), 1);
});

test('benchmark median handles odd and even samples', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test('benchmark thresholds reject accuracy, completeness, and speed regressions', () => {
  const thresholds = { meanWer: 0.2, completeness: 0.95, emptyRate: 0.05, medianLatencyMs: 1000, meanRtf: 0.5 };
  assert.deepEqual(checkBenchmarkThresholds({
    meanWer: 0.1, completeness: 1, emptyRate: 0, medianLatencyMs: 100, meanRtf: 0.1,
  }, thresholds), []);
  const violations = checkBenchmarkThresholds({
    meanWer: 0.3, completeness: 0.8, emptyRate: 0.2, medianLatencyMs: 2000, meanRtf: 0.9,
  }, thresholds);
  assert.deepEqual(violations.map((item) => item.name), ['meanWer', 'completeness', 'emptyRate', 'medianLatencyMs', 'meanRtf']);
});

test('benchmark process metrics are unavailable on Windows instead of zero', () => {
  assert.equal(processStats(1234, {
    platform: 'win32',
    spawnImpl: () => { throw new Error('ps must not run on Windows'); },
  }), null);
});

test('benchmark runner accepts an injected worker and fixture directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-benchmark-'));
  try {
    fs.writeFileSync(path.join(directory, 'accent-us.wav'), pcmToWav(Buffer.alloc(24000 * 2), 24000, 1));
    const seen = [];
    const worker = {
      pid: null,
      async warmModel(_id, options) { seen.push(options.backend); },
      async transcribe(options) { seen.push(options.backend); return { text: 'What was the hardest reliability issue you solved?', durationMs: 100 }; },
    };
    const report = await runBenchmark({
      fixtureDir: directory,
      worker,
      backend: 'cpu',
      statsImpl: () => null,
      gpuStatsImpl: () => ({ deviceUtilization: 87, rendererUtilization: 84, tilerUtilization: 85, driverMemoryBytes: 1000, systemMemoryBytes: 2000, recoveryCount: 0 }),
      thermalStatsImpl: () => 'nominal',
    });
    assert.equal(report.summary.fixtures, 1);
    assert.equal(report.summary.meanWer, 0);
    assert.equal(report.summary.meanRtf, 0.1);
    assert.equal(report.summary.maxRssKb, null);
    assert.equal(report.summary.meanCpuPercent, null);
    assert.equal(report.summary.gpuUtilization, 87);
    assert.equal(report.summary.maxGpuUtilization, 87);
    assert.equal(report.rows[0].gpuUtilization, 87);
    assert.equal(report.thermalPressure, 'nominal');
    assert.ok(report.hardware.cpuModel);
    assert.equal(report.backend, 'cpu');
    assert.deepEqual(seen, ['cpu', 'cpu']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('benchmark args select a validated compute backend', () => {
  assert.equal(parseArgs(['--backend=cpu']).backend, 'cpu');
  assert.equal(parseArgs(['--backend=gpu']).backend, 'gpu');
  assert.equal(parseArgs([]).backend, 'auto');
  assert.throws(() => parseArgs(['--backend=quantum']), /Unsupported benchmark backend/);
});

test('benchmark args can disable optional GPU sampling', () => {
  assert.equal(parseArgs(['--no-gpu-metrics']).gpuMetrics, false);
  assert.equal(parseArgs([]).gpuMetrics, true);
});

test('benchmark summary printing handles measured and unavailable GPU metrics', () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    printSummary({ summary: { fixtures: 1, meanWer: 0, medianLatencyMs: 10, meanInferenceMs: 10, meanRtf: 0.01, emptyRate: 0, completeness: 1, coldStartMs: 10, maxRssKb: null, meanCpuPercent: null, gpuUtilization: null, maxGpuUtilization: null, gpuMemoryBytes: null }, thermalPressure: null, hardware: {} });
    printSummary({ summary: { fixtures: 1, meanWer: 0, medianLatencyMs: 10, meanInferenceMs: 10, meanRtf: 0.01, emptyRate: 0, completeness: 1, coldStartMs: 10, maxRssKb: 100, meanCpuPercent: 5, gpuUtilization: 90, maxGpuUtilization: 96, gpuMemoryBytes: 1024 * 1024 }, thermalPressure: 'nominal', hardware: { cpuModel: 'Apple M2 Pro' } });
  } finally {
    console.log = originalLog;
  }
  assert.ok(lines.some((line) => line.includes('mean 90.0%, max 96.0%')));
  assert.ok(lines.some((line) => line.includes('Apple M2 Pro')));
});

test('benchmark summary reports accuracy, latency, RTF, RAM, and completeness', () => {
  const summary = summarizeBenchmark([
    { wer: 0, latencyMs: 100, inferenceMs: 50, audioSeconds: 1, text: 'one', maxRssKb: 100000, gpuUtilization: 90, gpuMemoryBytes: 1000 },
    { wer: 0.5, latencyMs: 300, inferenceMs: 150, audioSeconds: 1, text: '', maxRssKb: 200000, gpuUtilization: 100, gpuMemoryBytes: 2000 },
  ], { coldStartMs: 1000 });

  assert.equal(summary.fixtures, 2);
  assert.equal(summary.meanWer, 0.25);
  assert.equal(summary.medianLatencyMs, 200);
  assert.equal(summary.meanRtf, 0.1);
  assert.equal(summary.emptyRate, 0.5);
  assert.equal(summary.completeness, 0.5);
  assert.equal(summary.maxRssKb, 200000);
  assert.equal(summary.gpuUtilization, 95);
  assert.equal(summary.maxGpuUtilization, 100);
  assert.equal(summary.gpuMemoryBytes, 2000);
  assert.equal(summary.coldStartMs, 1000);
});
