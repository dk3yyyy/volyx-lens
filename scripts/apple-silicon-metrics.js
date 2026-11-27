'use strict';

const { spawnSync } = require('node:child_process');

function boundedPercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseAppleGpuStats(output) {
  const match = String(output || '').match(/"PerformanceStatistics"\s*=\s*(\{[^}]*\})/);
  if (!match) return null;
  let stats;
  try {
    stats = JSON.parse(match[1].replace(/=/g, ':'));
  } catch {
    return null;
  }
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
  return {
    deviceUtilization: boundedPercent(stats['Device Utilization %']),
    rendererUtilization: boundedPercent(stats['Renderer Utilization %']),
    tilerUtilization: boundedPercent(stats['Tiler Utilization %']),
    driverMemoryBytes: nonNegativeNumber(stats['In use system memory (driver)']),
    systemMemoryBytes: nonNegativeNumber(stats['In use system memory']),
    recoveryCount: nonNegativeNumber(stats.recoveryCount),
  };
}

function parseThermalPressure(output) {
  const text = String(output || '');
  if (/no thermal warning level/i.test(text) || /thermal warning level:\s*nominal/i.test(text)) return 'nominal';
  if (/thermal warning level:\s*critical/i.test(text)) return 'critical';
  if (/thermal warning level:\s*(?:warning|moderate|serious)/i.test(text)) return 'warning';
  return null;
}

function sampleAppleGpuStats({ platform = process.platform, spawnImpl = spawnSync } = {}) {
  if (platform !== 'darwin') return null;
  try {
    const result = spawnImpl('ioreg', ['-l', '-w0', '-r', '-c', 'AGXAccelerator'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.status !== 0) return null;
    return parseAppleGpuStats(result.stdout);
  } catch {
    return null;
  }
}

function sampleThermalPressure({ platform = process.platform, spawnImpl = spawnSync } = {}) {
  if (platform !== 'darwin') return null;
  try {
    const result = spawnImpl('pmset', ['-g', 'therm'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 16 * 1024,
    });
    if (result.status !== 0) return null;
    return parseThermalPressure(result.stdout);
  } catch {
    return null;
  }
}

module.exports = {
  parseAppleGpuStats,
  parseThermalPressure,
  sampleAppleGpuStats,
  sampleThermalPressure,
};
