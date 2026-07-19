const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function buildVisionOcr(context = {}) {
  const projectDir = context.appDir || path.resolve(__dirname, '..');
  const outputDir = path.join(projectDir, 'native-bin');
  const output = path.join(outputDir, 'volyx-lens-vision-ocr');
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.rm(output, { force: true });
  if ((context.electronPlatformName || process.platform) !== 'darwin') return;

  const source = path.join(projectDir, 'native', 'macos-vision-ocr.swift');
  const result = spawnSync('xcrun', [
    '--sdk', 'macosx', 'swiftc', source,
    '-O', '-whole-module-optimization',
    '-framework', 'Vision', '-framework', 'AppKit',
    '-o', output,
  ], {
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
}

exports.default = buildVisionOcr;
module.exports.buildVisionOcr = buildVisionOcr;
