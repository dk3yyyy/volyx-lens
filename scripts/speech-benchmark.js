#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getModel } = require('../src/speech-model-registry');
const { defaultSpeechWorker } = require('../src/speech-worker');
const { buildFixtures, decodeWav, normalizeText, wer } = require('./vad-accuracy-eval');
const { sampleAppleGpuStats, sampleThermalPressure } = require('./apple-silicon-metrics');

const DEFAULT_FIXTURE_DIR = path.join(__dirname, '..', 'node_modules', '.cache', 'vad-eval');
const DEFAULT_THRESHOLDS = Object.freeze({
  meanWer: 0.25,
  completeness: 0.95,
  emptyRate: 0.05,
  medianLatencyMs: 2000,
  meanRtf: 0.5,
});

function checkBenchmarkThresholds(summary, thresholds = DEFAULT_THRESHOLDS) {
  const violations = [];
  const lower = (name) => {
    if (Number.isFinite(summary[name]) && Number.isFinite(thresholds[name]) && summary[name] > thresholds[name]) {
      violations.push({ name, actual: summary[name], limit: thresholds[name] });
    }
  };
  const higher = (name) => {
    if (Number.isFinite(summary[name]) && Number.isFinite(thresholds[name]) && summary[name] < thresholds[name]) {
      violations.push({ name, actual: summary[name], limit: thresholds[name] });
    }
  };
  lower('meanWer');
  higher('completeness');
  lower('emptyRate');
  lower('medianLatencyMs');
  lower('meanRtf');
  return violations;
}

function audioDurationSeconds(wav) {
  const { pcm, sampleRate } = decodeWav(wav);
  if (!sampleRate) throw new Error('WAV sample rate is invalid.');
  return pcm.length / 2 / sampleRate;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((total, value) => total + value, 0) / usable.length : 0;
}

function summarizeBenchmark(rows, { coldStartMs = 0 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    fixtures: list.length,
    meanWer: mean(list.map((row) => row.wer)),
    medianLatencyMs: median(list.map((row) => row.latencyMs)),
    meanInferenceMs: mean(list.map((row) => row.inferenceMs)),
    meanRtf: mean(list.map((row) => (
      Number.isFinite(row.rtf) ? row.rtf : (row.audioSeconds > 0 ? row.inferenceMs / 1000 / row.audioSeconds : 0)
    ))),
    emptyRate: list.length ? list.filter((row) => !String(row.text || '').trim()).length / list.length : 1,
    completeness: list.length ? list.filter((row) => String(row.text || '').trim()).length / list.length : 0,
    maxRssKb: (() => {
      const values = list.map((row) => row.maxRssKb).filter(Number.isFinite);
      return values.length ? Math.max(...values) : null;
    })(),
    meanCpuPercent: (() => {
      const values = list.map((row) => row.cpuPercent).filter(Number.isFinite);
      return values.length ? mean(values) : null;
    })(),
    gpuUtilization: (() => {
      const values = list.map((row) => row.gpuUtilization).filter(Number.isFinite);
      return values.length ? mean(values) : null;
    })(),
    maxGpuUtilization: (() => {
      const values = list.map((row) => row.gpuUtilization).filter(Number.isFinite);
      return values.length ? Math.max(...values) : null;
    })(),
    gpuMemoryBytes: (() => {
      const values = list.map((row) => row.gpuMemoryBytes).filter(Number.isFinite);
      return values.length ? Math.max(...values) : null;
    })(),
    coldStartMs,
  };
}

function processStats(pid, { platform = process.platform, spawnImpl = spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || platform === 'win32') return null;
  const result = spawnImpl('ps', ['-o', 'rss=', '-o', '%cpu=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (result.status !== 0) return null;
  const [rss, cpu] = String(result.stdout || '').trim().split(/\s+/);
  return { maxRssKb: Number(rss) || 0, cpuPercent: Number(cpu) || 0 };
}

function parseArgs(argv) {
  const args = { modelId: 'parakeet-unified-en', language: 'en', backend: 'auto', fixtureDir: DEFAULT_FIXTURE_DIR, limit: 0, json: '', includeOverlays: false, check: false, gpuMetrics: true, thresholds: DEFAULT_THRESHOLDS };
  for (const value of argv) {
    if (value.startsWith('--model=')) args.modelId = value.slice('--model='.length);
    else if (value.startsWith('--language=')) args.language = value.slice('--language='.length);
    else if (value.startsWith('--backend=')) {
      const backend = value.slice('--backend='.length);
      if (!['auto', 'cpu', 'gpu'].includes(backend)) throw new Error(`Unsupported benchmark backend: ${backend}`);
      args.backend = backend;
    }
    else if (value.startsWith('--fixtures=')) args.fixtureDir = path.resolve(value.slice('--fixtures='.length));
    else if (value.startsWith('--limit=')) args.limit = Math.max(0, Number(value.slice('--limit='.length)) || 0);
    else if (value.startsWith('--json=')) args.json = path.resolve(value.slice('--json='.length));
    else if (value === '--include-overlays') args.includeOverlays = true;
    else if (value === '--check') args.check = true;
    else if (value === '--no-gpu-metrics') args.gpuMetrics = false;
    else if (value.startsWith('--thresholds=')) args.thresholds = JSON.parse(fs.readFileSync(path.resolve(value.slice('--thresholds='.length)), 'utf8'));
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function runBenchmark(options = {}) {
  const modelId = options.modelId || 'parakeet-unified-en';
  const language = options.language || 'en';
  const backend = options.backend || 'auto';
  if (!['auto', 'cpu', 'gpu'].includes(backend)) throw new Error(`Unsupported benchmark backend: ${backend}`);
  const fixtureDir = options.fixtureDir || DEFAULT_FIXTURE_DIR;
  const limit = Math.max(0, Number(options.limit) || 0);
  const model = getModel(modelId);
  if (!model || model.runtime !== 'transcribe-cpp') throw new Error(`Unsupported benchmark model: ${modelId}`);
  const worker = options.worker || defaultSpeechWorker;
  const statsImpl = options.statsImpl || processStats;
  const gpuStatsImpl = options.gpuStatsImpl || (options.gpuMetrics === false ? () => null : sampleAppleGpuStats);
  const thermalStatsImpl = options.thermalStatsImpl || sampleThermalPressure;
  if (!fs.existsSync(fixtureDir)) throw new Error(`Fixture directory not found: ${fixtureDir}. Run npm run eval:vad -- --regenerate first.`);

  const fixtures = buildFixtures()
    .filter((fixture) => fixture.kind === 'speech')
    .filter((fixture) => options.includeOverlays || !fixture.overlay)
    .filter((fixture) => fs.existsSync(path.join(fixtureDir, `${fixture.id}.wav`)))
    .slice(0, limit || undefined);
  if (!fixtures.length) throw new Error('No speech fixtures are available.');

  console.log(`Loading ${model.name} (${model.id})…`);
  const coldStartedAt = performance.now();
  await worker.warmModel(model.id, { backend });
  const coldStartMs = Math.round(performance.now() - coldStartedAt);

  const rows = [];
  for (const fixture of fixtures) {
    const wav = fs.readFileSync(path.join(fixtureDir, `${fixture.id}.wav`));
    const audioSeconds = audioDurationSeconds(wav);
    const before = statsImpl(worker.pid) || {};
    const startedAt = performance.now();
    const result = await worker.transcribe({ wav, modelId: model.id, language, backend });
    const latencyMs = Math.round(performance.now() - startedAt);
    const after = statsImpl(worker.pid) || {};
    const gpuAfter = gpuStatsImpl() || {};
    const text = String(result && result.text || '').trim();
    const inferenceMs = Number(result && result.durationMs) || latencyMs;
    const row = {
      id: fixture.id,
      category: fixture.category,
      reference: fixture.text,
      hypothesis: text,
      normalizedReference: normalizeText(fixture.text),
      normalizedHypothesis: normalizeText(text),
      wer: wer(fixture.text, text),
      audioSeconds,
      latencyMs,
      inferenceMs,
      rtf: audioSeconds > 0 ? inferenceMs / 1000 / audioSeconds : null,
      maxRssKb: [before.maxRssKb, after.maxRssKb].some(Number.isFinite)
        ? Math.max(before.maxRssKb || 0, after.maxRssKb || 0)
        : null,
      cpuPercent: Number.isFinite(after.cpuPercent) ? after.cpuPercent : null,
      gpuUtilization: Number.isFinite(gpuAfter.deviceUtilization) ? gpuAfter.deviceUtilization : null,
      gpuRendererUtilization: Number.isFinite(gpuAfter.rendererUtilization) ? gpuAfter.rendererUtilization : null,
      gpuTilerUtilization: Number.isFinite(gpuAfter.tilerUtilization) ? gpuAfter.tilerUtilization : null,
      gpuMemoryBytes: Number.isFinite(gpuAfter.systemMemoryBytes) ? gpuAfter.systemMemoryBytes : null,
      gpuRecoveryCount: Number.isFinite(gpuAfter.recoveryCount) ? gpuAfter.recoveryCount : null,
      text,
    };
    rows.push(row);
    console.log(`${fixture.id.padEnd(22)} WER ${(row.wer * 100).toFixed(1).padStart(5)}%  ${latencyMs.toString().padStart(6)} ms  RTF ${row.rtf.toFixed(2)}  RSS ${row.maxRssKb === null ? 'unavailable' : `${row.maxRssKb} KB`}`);
  }

  const summary = summarizeBenchmark(rows, { coldStartMs });
  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hardware: {
      arch: process.arch,
      cpuModel: os.cpus()[0] && os.cpus()[0].model || '',
      totalMemoryBytes: os.totalmem(),
    },
    thermalPressure: thermalStatsImpl(),
    model: { id: model.id, name: model.name, version: model.version, artifact: model.artifact },
    language,
    backend,
    summary,
    rows,
  };
  return report;
}

function printSummary(report) {
  const { summary } = report;
  console.log('\nSpeech benchmark summary');
  console.log(`  fixtures:          ${summary.fixtures}`);
  console.log(`  mean WER:          ${(summary.meanWer * 100).toFixed(1)}%`);
  console.log(`  median latency:    ${summary.medianLatencyMs} ms`);
  console.log(`  mean inference:    ${summary.meanInferenceMs} ms`);
  console.log(`  mean RTF:          ${summary.meanRtf.toFixed(3)}`);
  console.log(`  empty rate:        ${(summary.emptyRate * 100).toFixed(1)}%`);
  console.log(`  completeness:      ${(summary.completeness * 100).toFixed(1)}%`);
  console.log(`  requested backend: ${report.backend || 'auto'}`);
  console.log(`  cold start:        ${summary.coldStartMs} ms`);
  console.log(`  max child RSS:     ${summary.maxRssKb === null ? 'unavailable on this platform' : `${summary.maxRssKb} KB`}`);
  console.log(`  mean child CPU:    ${summary.meanCpuPercent === null ? 'unavailable on this platform' : `${summary.meanCpuPercent.toFixed(1)}%`}`);
  console.log(`  GPU utilization:  ${summary.gpuUtilization === null ? 'unavailable on this platform' : `mean ${summary.gpuUtilization.toFixed(1)}%, max ${summary.maxGpuUtilization.toFixed(1)}%`}`);
  console.log(`  GPU memory:       ${summary.gpuMemoryBytes === null ? 'unavailable on this platform' : `${(summary.gpuMemoryBytes / (1024 * 1024)).toFixed(0)} MiB`}`);
  console.log(`  Thermal pressure: ${report.thermalPressure || 'unavailable on this platform'}`);
  if (report.hardware && report.hardware.cpuModel) console.log(`  Hardware:         ${report.hardware.cpuModel}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await runBenchmark(args);
    printSummary(report);
    if (args.json) {
      fs.mkdirSync(path.dirname(args.json), { recursive: true });
      fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      console.log(`Report: ${args.json}`);
    }
    if (args.check) {
      const violations = checkBenchmarkThresholds(report.summary, args.thresholds);
      if (violations.length) {
        for (const violation of violations) console.error(`THRESHOLD FAILED: ${violation.name}=${violation.actual} (limit ${violation.limit})`);
        process.exitCode = 1;
      } else {
        console.log('All speech benchmark thresholds passed.');
      }
    }
  } finally {
    await defaultSpeechWorker.stop();
  }
}

module.exports = { audioDurationSeconds, median, mean, summarizeBenchmark, checkBenchmarkThresholds, DEFAULT_THRESHOLDS, processStats, parseArgs, runBenchmark, printSummary };

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}
