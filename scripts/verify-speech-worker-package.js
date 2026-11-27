'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKER_NAME = 'volyx-speech-worker';

function normalizeArch(value) {
  const arch = String(value || '').toLowerCase();
  if (['x64', 'x86_64', 'amd64'].includes(arch)) return 'x86_64';
  if (['arm64', 'aarch64'].includes(arch)) return 'arm64';
  throw new Error(`Unsupported speech worker architecture: ${String(value || '')}`);
}

function workerName(platform) {
  if (platform === 'win32') return `${WORKER_NAME}.exe`;
  if (['darwin', 'linux'].includes(platform)) return WORKER_NAME;
  throw new Error(`Unsupported speech worker platform: ${platform}`);
}

function findWorker(directory, name, fsImpl = fs) {
  if (!fsImpl.existsSync(directory)) return null;
  const direct = path.join(directory, name);
  if (fsImpl.existsSync(direct) && fsImpl.lstatSync(direct).isFile()) return direct;
  for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return file;
    if (entry.isDirectory()) {
      const nested = findWorker(file, name, fsImpl);
      if (nested) return nested;
    }
  }
  return null;
}

function binaryFormat(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20) throw new Error('Speech worker binary is too small to inspect.');
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return 'elf';
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return 'pe';
  const magic = bytes.readUInt32LE(0);
  if ([0xfeedface, 0xfeedfacf].includes(magic)) return 'mach-o';
  if (magic === 0xcafebabe || magic === 0xbebafeca) return 'universal-mach-o';
  throw new Error('Unrecognized speech worker binary format.');
}

function binaryArchitectures(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20) throw new Error('Speech worker binary is too small to inspect.');
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    if (![1, 2].includes(bytes[4]) || ![1, 2].includes(bytes[5])) throw new Error('Unsupported ELF encoding.');
    const read16 = bytes[5] === 2 ? bytes.readUInt16BE.bind(bytes) : bytes.readUInt16LE.bind(bytes);
    const machine = read16(18);
    const arch = { 3: 'x86', 62: 'x86_64', 40: 'arm', 183: 'arm64' }[machine];
    if (!arch) throw new Error(`Unsupported ELF machine type: ${machine}.`);
    return [arch];
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const offset = bytes.readUInt32LE(0x3c);
    if (offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') {
      throw new Error('Invalid PE header.');
    }
    const machine = bytes.readUInt16LE(offset + 4);
    const arch = { 0x14c: 'x86', 0x8664: 'x86_64', 0x1c0: 'arm', 0x1c4: 'arm', 0xaa64: 'arm64' }[machine];
    if (!arch) throw new Error(`Unsupported PE machine type: 0x${machine.toString(16)}.`);
    return [arch];
  }

  const magic = bytes.readUInt32LE(0);
  const machoCpu = { 7: 'x86', 0x01000007: 'x86_64', 12: 'arm', 0x0100000c: 'arm64' };
  if ([0xfeedface, 0xfeedfacf].includes(magic)) {
    const arch = machoCpu[bytes.readUInt32LE(4)];
    if (!arch) throw new Error('Unsupported Mach-O CPU type.');
    return [arch];
  }
  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    const little = magic === 0xcafebabe;
    const read32 = little ? bytes.readUInt32LE.bind(bytes) : bytes.readUInt32BE.bind(bytes);
    const count = read32(4);
    const entrySize = 20;
    const archs = [];
    for (let index = 0; index < Math.min(count, 32); index += 1) {
      const offset = 8 + index * entrySize;
      if (offset + entrySize > bytes.length) throw new Error('Truncated universal Mach-O header.');
      const arch = machoCpu[read32(offset)];
      if (arch) archs.push(arch);
    }
    if (!archs.length) throw new Error('Universal Mach-O contains no supported desktop architecture.');
    return [...new Set(archs)];
  }
  throw new Error('Unrecognized speech worker binary format.');
}

function validateSelfTestPayload(payload) {
  return Boolean(payload
    && payload.ok === true
    && payload.engine === 'transcribe-cpp'
    && payload.protocol === 1
    && payload.streaming === true
    && payload.diarization === true);
}

function verifySpeechWorkerPackage({
  directory,
  platform = process.platform,
  arch = process.arch,
  hostPlatform = process.platform,
  hostArch = process.arch,
  fsImpl = fs,
  spawnImpl = spawnSync,
  // Windows has no POSIX mode bits; a mode read there is meaningless.
  checkPermissions = process.platform !== 'win32',
} = {}) {
  if (!directory) throw new Error('A packaged application directory is required.');
  const expectedArch = normalizeArch(arch);
  const name = workerName(platform);
  const worker = findWorker(directory, name, fsImpl);
  if (!worker) throw new Error(`Packaged speech worker was not found: ${name}.`);
  const stat = fsImpl.lstatSync(worker);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Packaged speech worker must be a regular file.');
  if (checkPermissions && platform !== 'win32' && (stat.mode & 0o002) !== 0) {
    throw new Error(`Packaged speech worker has unsafe permissions: ${worker}.`);
  }
  const header = Buffer.alloc(4096);
  const fd = fsImpl.openSync(worker, 'r');
  let architectures;
  let format;
  try {
    const read = fsImpl.readSync(fd, header, 0, header.length, 0);
    const bytes = header.subarray(0, read);
    format = binaryFormat(bytes);
    architectures = binaryArchitectures(bytes);
  } finally {
    fsImpl.closeSync(fd);
  }
  const expectedFormats = platform === 'win32' ? ['pe'] : platform === 'linux' ? ['elf'] : ['mach-o', 'universal-mach-o'];
  if (!expectedFormats.includes(format)) {
    throw new Error(`${platform} package expects ${expectedFormats.join(' or ')}; found ${format}.`);
  }
  if (!architectures.includes(expectedArch)) {
    throw new Error(`${name} targets ${architectures.join(', ')}, but this package targets ${expectedArch}.`);
  }
  const canExecute = platform === hostPlatform && normalizeArch(hostArch) === expectedArch;
  if (!canExecute) {
    return { path: worker, architectures, executed: false };
  }
  const result = spawnImpl(worker, ['--self-test'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-2000);
    throw new Error(`Packaged speech worker self-test failed (exit ${result.status}).${detail ? ` ${detail}` : ''}`);
  }
  let payload;
  try { payload = JSON.parse(String(result.stdout || '').trim()); }
  catch { throw new Error('Packaged speech worker returned invalid self-test JSON.'); }
  if (!validateSelfTestPayload(payload)) throw new Error('Packaged speech worker returned an invalid self-test payload.');
  return { path: worker, architectures, executed: true, payload };
}

function defaultDirectory(root, platform, arch) {
  const normalized = normalizeArch(arch);
  const directories = {
    'darwin-x86_64': 'mac',
    'darwin-arm64': 'mac-arm64',
    'win32-x86_64': 'win-unpacked',
    'win32-arm64': 'win-arm64-unpacked',
    'linux-x86_64': 'linux-unpacked',
    'linux-arm64': 'linux-arm64-unpacked',
  };
  const output = directories[`${platform}-${normalized}`];
  if (!output) throw new Error(`Unsupported speech worker platform: ${platform}`);
  return path.join(root, 'dist', output);
}

function parsePackageArgs(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--') && value.includes('=')) {
      const separator = value.indexOf('=');
      args.set(value.slice(2, separator), value.slice(separator + 1));
    } else if (value.startsWith('--') && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args.set(value.slice(2), argv[++index]);
    }
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parsePackageArgs(argv);
  const root = path.resolve(__dirname, '..');
  const platform = args.get('platform') || process.platform;
  const arch = args.get('arch') || process.env.npm_config_arch || process.env.VOLYX_LENS_EXPECTED_ARCH || process.arch;
  const directory = path.resolve(args.get('dir') || defaultDirectory(root, platform, arch));
  const result = verifySpeechWorkerPackage({ directory, platform, arch });
  console.log(`Packaged speech worker verified: ${path.relative(root, result.path)} (${normalizeArch(arch)})`);
  if (!result.executed) console.log('Execution skipped because the package architecture differs from the host.');
}

module.exports = {
  WORKER_NAME,
  binaryArchitectures,
  binaryFormat,
  defaultDirectory,
  findWorker,
  normalizeArch,
  parsePackageArgs,
  validateSelfTestPayload,
  verifySpeechWorkerPackage,
};

if (require.main === module) main();
