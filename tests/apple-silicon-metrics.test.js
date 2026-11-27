'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAppleGpuStats,
  parseThermalPressure,
  sampleAppleGpuStats,
  sampleThermalPressure,
} = require('../scripts/apple-silicon-metrics');

const IOREG_SAMPLE = `+-o AGXAccelerator <class AGXAccelerator, id 0x123>
  | {
  |   "PerformanceStatistics" = {"In use system memory (driver)"=472907776,"Alloc system memory"=7317635072,"Tiler Utilization %"=94,"recoveryCount"=0,"lastRecoveryTime"=0,"Renderer Utilization %"=93,"Device Utilization %"=96,"In use system memory"=1604943872}
  | }
`;

test('Apple GPU parser extracts bounded utilization, memory, and recovery counters', () => {
  assert.deepEqual(parseAppleGpuStats(IOREG_SAMPLE), {
    deviceUtilization: 96,
    rendererUtilization: 93,
    tilerUtilization: 94,
    driverMemoryBytes: 472907776,
    systemMemoryBytes: 1604943872,
    recoveryCount: 0,
  });
  assert.equal(parseAppleGpuStats('unrelated output'), null);
  assert.equal(parseAppleGpuStats('"PerformanceStatistics" = {"Device Utilization %"=140}').deviceUtilization, 100);
  assert.equal(parseAppleGpuStats('"PerformanceStatistics" = {"Device Utilization %"=null}').deviceUtilization, null);
});

test('thermal pressure parser distinguishes nominal, warning, and critical states', () => {
  assert.equal(parseThermalPressure('Note: No thermal warning level has been recorded'), 'nominal');
  assert.equal(parseThermalPressure('Thermal warning level: Moderate'), 'warning');
  assert.equal(parseThermalPressure('Thermal warning level: Critical'), 'critical');
  assert.equal(parseThermalPressure('unrecognized'), null);
});

test('Apple GPU sampler is a no-op off macOS and bounds command execution', () => {
  assert.equal(sampleAppleGpuStats({
    platform: 'linux',
    spawnImpl: () => { throw new Error('ioreg must not run on Linux'); },
  }), null);
  const calls = [];
  const stats = sampleAppleGpuStats({
    platform: 'darwin',
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: IOREG_SAMPLE, stderr: '' };
    },
  });
  assert.equal(stats.deviceUtilization, 96);
  assert.equal(calls[0].command, 'ioreg');
  assert.ok(calls[0].args.includes('AGXAccelerator'));
  assert.equal(calls[0].options.timeout, 3000);
});

test('thermal sampler returns null when macOS does not report a state', () => {
  assert.equal(sampleThermalPressure({
    platform: 'darwin',
    spawnImpl: () => ({ status: 1, stdout: '', stderr: 'unsupported' }),
  }), null);
});
