const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Both helpers have to be built for the packaged app's architecture, not for the
// runner's. The unsigned Intel DMG was built on an arm64 runner and shipped an
// arm64 OCR helper inside an x64 app, so every OCR spawn failed on real Intel
// hardware while the self-test (running on the same arm64 box) still passed.
const ARCH_BY_NAME = { 1: 'x86_64', 3: 'arm64', x64: 'x86_64', arm64: 'arm64' };

function targetArchFor(context = {}) {
  return ARCH_BY_NAME[context && context.arch] || ARCH_BY_NAME[process.arch] || 'arm64';
}

function visionCompileArgs({ source, output, targetArch }) {
  return [
    '--sdk', 'macosx', 'swiftc', source,
    '-O', '-whole-module-optimization',
    '-target', `${targetArch}-apple-macos12.0`,
    '-framework', 'Vision', '-framework', 'AppKit',
    '-o', output,
  ];
}

function audioCompileArgs({ source, output, targetArch }) {
  return [
    '--sdk', 'macosx', 'swiftc', source,
    '-O', '-whole-module-optimization', '-warnings-as-errors', '-parse-as-library',
    '-target', `${targetArch}-apple-macos13.0`,
    '-framework', 'ScreenCaptureKit', '-framework', 'CoreMedia', '-framework', 'CoreAudio',
    '-o', output,
  ];
}

async function buildVisionOcr(context = {}) {
  const projectDir = context.appDir || path.resolve(__dirname, '..');
  const outputDir = path.join(projectDir, 'native-bin');
  const output = path.join(outputDir, 'volyx-lens-vision-ocr');
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.rm(output, { force: true });
  if ((context.electronPlatformName || process.platform) !== 'darwin') return;

  const targetArch = targetArchFor(context);
  const source = path.join(projectDir, 'native', 'macos-vision-ocr.swift');
  const result = spawnSync('xcrun', visionCompileArgs({ source, output, targetArch }), {
    cwd: projectDir,
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET || '12.0' },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 4000);
    throw new Error(`Could not build the macOS Vision OCR helper.${detail ? `\n${detail}` : ''}`);
  }
  await fs.promises.chmod(output, 0o755);

  const audioSource = path.join(projectDir, 'native', 'macos-system-audio.swift');
  const audioOutput = path.join(outputDir, 'volyx-lens-system-audio');
  await fs.promises.rm(audioOutput, { force: true });
  const audioResult = spawnSync('xcrun', audioCompileArgs({ source: audioSource, output: audioOutput, targetArch }), {
    cwd: projectDir,
    env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: '13.0' },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (audioResult.status !== 0) {
    const detail = String(audioResult.stderr || audioResult.stdout || '').trim().slice(0, 4000);
    throw new Error(`Could not build the macOS system-audio helper.${detail ? `\n${detail}` : ''}`);
  }
  await fs.promises.chmod(audioOutput, 0o755);
}

exports.default = buildVisionOcr;
module.exports.buildVisionOcr = buildVisionOcr;
module.exports.visionCompileArgs = visionCompileArgs;
module.exports.audioCompileArgs = audioCompileArgs;
module.exports.targetArchFor = targetArchFor;
