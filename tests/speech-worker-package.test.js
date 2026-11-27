'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  binaryArchitectures,
  binaryFormat,
  defaultDirectory,
  parsePackageArgs,
  verifySpeechWorkerPackage,
  validateSelfTestPayload,
} = require('../scripts/verify-speech-worker-package');

function elf(machine) {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46]);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

function pe(machine) {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ', 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

function macho(cpuType) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpuType, 4);
  return bytes;
}

function universalMacho(cpuTypes) {
  const bytes = Buffer.alloc(8 + cpuTypes.length * 20);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpuType, index) => bytes.writeUInt32BE(cpuType, 8 + index * 20));
  return bytes;
}

function fixture({ platform = 'linux', bytes = elf(62), mode = 0o755 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-package-'));
  const native = path.join(directory, 'resources', 'native');
  fs.mkdirSync(native, { recursive: true });
  const name = platform === 'win32' ? 'volyx-speech-worker.exe' : 'volyx-speech-worker';
  const worker = path.join(native, name);
  fs.writeFileSync(worker, bytes, { mode });
  return { directory, worker };
}

function payload() {
  return { ok: true, engine: 'transcribe-cpp', protocol: 1, streaming: false, diarization: false };
}

test('binary architecture inspection understands ELF, PE, and Mach-O desktop targets', () => {
  assert.deepEqual(binaryArchitectures(elf(62)), ['x86_64']);
  assert.deepEqual(binaryArchitectures(elf(183)), ['arm64']);
  assert.deepEqual(binaryArchitectures(pe(0x8664)), ['x86_64']);
  assert.deepEqual(binaryArchitectures(pe(0xaa64)), ['arm64']);
  assert.deepEqual(binaryArchitectures(macho(0x01000007)), ['x86_64']);
  assert.deepEqual(binaryArchitectures(macho(0x0100000c)), ['arm64']);
  assert.deepEqual(binaryArchitectures(universalMacho([0x01000007, 0x0100000c])), ['x86_64', 'arm64']);
  assert.equal(binaryFormat(elf(62)), 'elf');
  assert.equal(binaryFormat(pe(0x8664)), 'pe');
  assert.equal(binaryFormat(macho(0x01000007)), 'mach-o');
  assert.equal(binaryFormat(universalMacho([0x01000007])), 'universal-mach-o');
});

test('packaged speech worker verification executes the target binary and validates its protocol', () => {
  const { directory, worker } = fixture();
  try {
    const calls = [];
    const result = verifySpeechWorkerPackage({
      directory,
      platform: 'linux',
      arch: 'x64',
      hostPlatform: 'linux',
      hostArch: 'x64',
      spawnImpl: (file, args) => {
        calls.push({ file, args });
        return { status: 0, stdout: JSON.stringify(payload()), stderr: '' };
      },
    });
    assert.equal(result.path, worker);
    assert.deepEqual(result.architectures, ['x86_64']);
    assert.deepEqual(calls, [{ file: worker, args: ['--self-test'] }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('packaged speech worker verification accepts Windows mode bits and skips cross-architecture execution', () => {
  const windows = fixture({ platform: 'win32', bytes: pe(0x8664), mode: 0o666 });
  try {
    const result = verifySpeechWorkerPackage({
      directory: windows.directory,
      platform: 'win32',
      arch: 'x64',
      hostPlatform: 'win32',
      hostArch: 'x64',
      spawnImpl: () => ({ status: 0, stdout: JSON.stringify(payload()), stderr: '' }),
    });
    assert.equal(result.path, windows.worker);
  } finally {
    fs.rmSync(windows.directory, { recursive: true, force: true });
  }

  const cross = fixture({ bytes: elf(183) });
  try {
    const result = verifySpeechWorkerPackage({
      directory: cross.directory,
      platform: 'linux',
      arch: 'arm64',
      hostPlatform: 'linux',
      hostArch: 'x64',
      spawnImpl: () => { throw new Error('cross-architecture worker must not execute'); },
    });
    assert.equal(result.executed, false);
  } finally {
    fs.rmSync(cross.directory, { recursive: true, force: true });
  }
});

test('packaged speech worker verification rejects the wrong binary format even when execution is skipped', () => {
  const windows = fixture({ platform: 'win32', bytes: elf(183), mode: 0o666 });
  try {
    assert.throws(() => verifySpeechWorkerPackage({
      directory: windows.directory,
      platform: 'win32',
      arch: 'arm64',
      hostPlatform: 'linux',
      hostArch: 'x64',
      spawnImpl: () => { throw new Error('cross-architecture worker must not execute'); },
    }), /expects pe/);
  } finally {
    fs.rmSync(windows.directory, { recursive: true, force: true });
  }
});

test('packaged speech worker verification rejects wrong architectures and unsafe POSIX permissions', () => {
  const wrong = fixture({ bytes: elf(183) });
  try {
    assert.throws(() => verifySpeechWorkerPackage({
      directory: wrong.directory,
      platform: 'linux',
      arch: 'x64',
      hostPlatform: 'linux',
      hostArch: 'x64',
      spawnImpl: () => ({ status: 0, stdout: JSON.stringify(payload()), stderr: '' }),
    }), /targets x86_64/);
  } finally {
    fs.rmSync(wrong.directory, { recursive: true, force: true });
  }

  const unsafe = fixture();
  try {
    const originalStat = fs.statSync.bind(fs);
    const fsImpl = {
      ...fs,
      lstatSync: (file) => {
        const stat = originalStat(file);
        return { isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink(), mode: 0o777 };
      },
    };
    assert.throws(() => verifySpeechWorkerPackage({
      directory: unsafe.directory,
      platform: 'linux',
      arch: 'x64',
      hostPlatform: 'linux',
      hostArch: 'x64',
      fsImpl,
      checkPermissions: true,
      spawnImpl: () => ({ status: 0, stdout: JSON.stringify(payload()), stderr: '' }),
    }), /unsafe permissions/);
  } finally {
    fs.rmSync(unsafe.directory, { recursive: true, force: true });
  }
});

test('packaged speech worker default directories match electron-builder output names', () => {
  const cases = [
    ['darwin', 'x64', 'mac'],
    ['darwin', 'arm64', 'mac-arm64'],
    ['win32', 'x64', 'win-unpacked'],
    ['win32', 'arm64', 'win-arm64-unpacked'],
    ['linux', 'x64', 'linux-unpacked'],
    ['linux', 'arm64', 'linux-arm64-unpacked'],
  ];
  for (const [platform, arch, output] of cases) {
    assert.equal(defaultDirectory('/repo', platform, arch), path.join('/repo', 'dist', output));
  }
});

test('packaged speech worker CLI parses explicit directory, platform, and architecture', () => {
  const args = parsePackageArgs(['--dir', '/package', '--platform=linux', '--arch', 'arm64']);
  assert.equal(args.get('dir'), '/package');
  assert.equal(args.get('platform'), 'linux');
  assert.equal(args.get('arch'), 'arm64');
});

test('packaged speech worker self-test payload is strict', () => {
  assert.equal(validateSelfTestPayload(payload()), true);
  assert.equal(validateSelfTestPayload({ ...payload(), protocol: 2 }), false);
  assert.equal(validateSelfTestPayload({ ...payload(), streaming: true }), false);
  assert.equal(validateSelfTestPayload({ ...payload(), diarization: true }), false);
  assert.equal(validateSelfTestPayload(null), false);
});
