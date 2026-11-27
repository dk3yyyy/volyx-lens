'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { speechWorkerTarget, cargoBuildArgs, speechWorkerBuildEnvironment } = require('../scripts/build-speech-worker');

test('speech worker target mapping covers every supported desktop architecture', () => {
  const cases = [
    ['darwin', 'arm64', 'aarch64-apple-darwin', 'volyx-speech-worker'],
    ['darwin', 'x64', 'x86_64-apple-darwin', 'volyx-speech-worker'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc', 'volyx-speech-worker.exe'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu', 'volyx-speech-worker'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu', 'volyx-speech-worker'],
  ];
  for (const [platform, arch, target, output] of cases) {
    assert.deepEqual(speechWorkerTarget({ electronPlatformName: platform, arch }), { target, output });
  }
});

test('speech worker target mapping rejects unknown platforms and architectures', () => {
  assert.throws(() => speechWorkerTarget({ electronPlatformName: 'freebsd', arch: 'x64' }), /Unsupported speech worker platform/);
  assert.throws(() => speechWorkerTarget({ electronPlatformName: 'darwin', arch: 'mips' }), /Unsupported speech worker architecture/);
  assert.throws(() => speechWorkerTarget({ electronPlatformName: 'win32', arch: 'arm64' }), /Unsupported speech worker architecture/);
});

test('speech worker cargo arguments are locked and target the packaged architecture', () => {
  assert.deepEqual(cargoBuildArgs({ manifest: '/repo/Cargo.toml', target: 'x86_64-pc-windows-msvc' }), [
    'build', '--locked', '--release', '--manifest-path', '/repo/Cargo.toml', '--target', 'x86_64-pc-windows-msvc',
  ]);
});

test('speech worker builds use portable CPU flags and native macOS deployment targets', () => {
  const linux = speechWorkerBuildEnvironment({ platform: 'linux', targetArch: 'x86_64', hostArch: 'x86_64', env: {}, cargoTargetDir: '/target' });
  assert.match(linux.TRANSCRIBE_CMAKE_ARGS, /-DGGML_NATIVE=OFF/);
  assert.match(linux.TRANSCRIBE_CMAKE_ARGS, /-DTRANSCRIBE_X86_CONSERVATIVE=ON/);
  assert.match(linux.TRANSCRIBE_CMAKE_ARGS, /-DTRANSCRIBE_USE_SYSTEM_BLAS=OFF/);
  const windows = speechWorkerBuildEnvironment({ platform: 'win32', targetArch: 'x86_64', hostArch: 'x86_64', env: {}, cargoTargetDir: '/target' });
  assert.match(windows.TRANSCRIBE_CMAKE_ARGS, /-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded/);
  const nativeMac = speechWorkerBuildEnvironment({ platform: 'darwin', targetArch: 'x86_64', hostArch: 'x86_64', env: {}, cargoTargetDir: '/target' });
  assert.equal(nativeMac.MACOSX_DEPLOYMENT_TARGET, '13.0');
  const crossMac = speechWorkerBuildEnvironment({ platform: 'darwin', targetArch: 'x86_64', hostArch: 'arm64', env: {}, cargoTargetDir: '/target' });
  assert.equal(crossMac.MACOSX_DEPLOYMENT_TARGET, undefined);
  assert.match(crossMac.RUSTFLAGS, /-C link-arg=-mmacosx-version-min=13\.0/);
  assert.match(crossMac.CFLAGS, /-mmacosx-version-min=13\.0/);
  assert.match(crossMac.CXXFLAGS, /-mmacosx-version-min=13\.0/);
});

test('speech worker opts into Vulkan only for explicit non-Apple builds', () => {
  assert.deepEqual(cargoBuildArgs({ manifest: '/repo/Cargo.toml', target: 'x86_64-unknown-linux-gnu', features: ['transcribe-cpp/vulkan'] }), [
    'build', '--locked', '--release', '--manifest-path', '/repo/Cargo.toml', '--target', 'x86_64-unknown-linux-gnu', '--features', 'transcribe-cpp/vulkan',
  ]);
});
