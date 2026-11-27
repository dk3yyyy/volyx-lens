'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { targetArchFor } = require('./build-vision-ocr');

const TARGETS = Object.freeze({
  'darwin-x86_64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x86_64': 'x86_64-pc-windows-msvc',
  'linux-x86_64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
});

function speechWorkerTarget(context = {}) {
  const platform = context.electronPlatformName || process.platform;
  if (!Object.hasOwn(TARGETS, `${platform}-x86_64`) && !Object.hasOwn(TARGETS, `${platform}-arm64`)) {
    throw new Error(`Unsupported speech worker platform: ${platform}`);
  }
  let arch;
  try { arch = targetArchFor(context); }
  catch { throw new Error(`Unsupported speech worker architecture: ${platform}/${String(context.arch || process.arch)}`); }
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported speech worker architecture: ${platform}/${arch}`);
  return { target, output: platform === 'win32' ? 'volyx-speech-worker.exe' : 'volyx-speech-worker' };
}

function cargoBuildArgs({ manifest, target, features = [] }) {
  const args = ['build', '--locked', '--release', '--manifest-path', manifest, '--target', target];
  if (features.length) args.push('--features', features.join(','));
  return args;
}

function speechWorkerBuildEnvironment({
  platform,
  targetArch,
  hostArch = process.arch,
  env = process.env,
  cargoTargetDir,
}) {
  const result = { ...env, CARGO_TARGET_DIR: cargoTargetDir };
  if (platform === 'darwin') {
    const deployment = result.MACOSX_DEPLOYMENT_TARGET || '13.0';
    if (targetArch === hostArch) {
      result.MACOSX_DEPLOYMENT_TARGET = deployment;
    } else {
      // Some Rust toolchains cannot load host proc-macro dylibs in a cross build
      // when MACOSX_DEPLOYMENT_TARGET is set. Enforce the same floor through the
      // target compiler/linker flags instead.
      delete result.MACOSX_DEPLOYMENT_TARGET;
      result.RUSTFLAGS = [result.RUSTFLAGS, `-C link-arg=-mmacosx-version-min=${deployment}`].filter(Boolean).join(' ');
      result.CFLAGS = [result.CFLAGS, `-mmacosx-version-min=${deployment}`].filter(Boolean).join(' ');
      result.CXXFLAGS = [result.CXXFLAGS, `-mmacosx-version-min=${deployment}`].filter(Boolean).join(' ');
    }
  }
  const portable = '-DGGML_NATIVE=OFF -DTRANSCRIBE_X86_CONSERVATIVE=ON -DTRANSCRIBE_USE_SYSTEM_BLAS=OFF -DTRANSCRIBE_USE_OPENMP=OFF'
    + (platform === 'win32' ? ' -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded' : '')
    + (platform === 'darwin' ? ` -DCMAKE_OSX_DEPLOYMENT_TARGET=${result.MACOSX_DEPLOYMENT_TARGET || env.MACOSX_DEPLOYMENT_TARGET || '13.0'}` : '');
  for (const key of ['TRANSCRIBE_CMAKE_ARGS', 'CMAKE_ARGS']) {
    result[key] = [result[key], portable].filter(Boolean).join(' ');
  }
  return result;
}

async function buildSpeechWorker(context = {}) {
  const projectDir = context.appDir || path.resolve(__dirname, '..');
  const outputDir = path.join(projectDir, 'native-bin');
  const { target, output } = speechWorkerTarget(context);
  const outputPath = path.join(outputDir, output);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await Promise.all(['volyx-speech-worker', 'volyx-speech-worker.exe'].map((name) => fs.promises.rm(path.join(outputDir, name), { force: true })));

  const platform = context.electronPlatformName || process.platform;
  const targetArch = targetArchFor(context);
  const manifest = path.join(projectDir, 'native', 'speech-worker', 'Cargo.toml');
  const cargoTargetDir = path.join(outputDir, 'speech-worker-target');
  const features = (platform === 'win32' || platform === 'linux')
    && (context.enableVulkan || process.env.VOLYX_LENS_SPEECH_VULKAN === '1')
    ? ['transcribe-cpp/vulkan']
    : [];
  const env = speechWorkerBuildEnvironment({ platform, targetArch, cargoTargetDir });

  const result = spawnSync('cargo', cargoBuildArgs({ manifest, target, features }), {
    cwd: projectDir,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-6000);
    throw new Error(`Could not build the ${platform}/${targetArchFor(context)} local speech worker.${detail ? `\n${detail}` : ''}`);
  }

  const builtBinary = path.join(cargoTargetDir, target, 'release', output);
  await fs.promises.copyFile(builtBinary, outputPath);
  await fs.promises.chmod(outputPath, 0o755);
  return { available: true, path: outputPath, target, features };
}

module.exports = { buildSpeechWorker, cargoBuildArgs, speechWorkerBuildEnvironment, speechWorkerTarget, TARGETS };
