'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { visionCompileArgs, audioCompileArgs, targetArchFor } = require('../scripts/build-vision-ocr');
const { assertHelperArch } = require('../scripts/verify-vision-ocr-package');

const root = path.join(__dirname, '..');

function targetOf(args) {
  const index = args.indexOf('-target');
  assert.ok(index >= 0, 'the compile command carries an explicit -target');
  return args[index + 1];
}

test('the vision helper is compiled for the requested architecture, not the host', () => {
  // The Intel DMG was built on an arm64 runner with no -target, so it shipped an
  // arm64 helper inside an x64 app and OCR was dead on real Intel hardware.
  for (const [arch, expected] of [['x64', 'x86_64'], ['arm64', 'arm64'], [1, 'x86_64'], [3, 'arm64']]) {
    const args = visionCompileArgs({ source: 'ocr.swift', output: 'ocr-bin', targetArch: targetArchFor({ arch }) });
    assert.equal(targetOf(args), `${expected}-apple-macos12.0`, `vision helper target for arch ${arch}`);
  }
});

test('the vision and audio helpers target the same architecture', () => {
  for (const arch of ['x64', 'arm64']) {
    const targetArch = targetArchFor({ arch });
    const visionArch = targetOf(visionCompileArgs({ source: 'a.swift', output: 'a', targetArch })).split('-apple-')[0];
    const audioArch = targetOf(audioCompileArgs({ source: 'b.swift', output: 'b', targetArch })).split('-apple-')[0];
    assert.equal(visionArch, audioArch, `both helpers target ${arch}`);
  }
});

test('the Intel build runs on an Intel runner instead of relying on a cross-compile', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'build-macos-unsigned.yml'), 'utf8'));
  assert.equal(workflow.jobs.build['runs-on'], '${{ matrix.runner }}', 'the job follows the matrix runner');
  const byArch = Object.fromEntries(workflow.jobs.build.strategy.matrix.include.map((entry) => [entry.arch, entry.runner]));
  assert.equal(byArch.arm64, 'macos-15');
  assert.equal(byArch.x64, 'macos-15-intel', 'the x64 DMG is built on an Intel runner');
});

test('macOS CI tests and packages natively on both supported architectures', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'));
  const job = workflow.jobs['macos-package'];
  assert.equal(job['runs-on'], '${{ matrix.runner }}');
  const byArch = Object.fromEntries(job.strategy.matrix.include.map((entry) => [entry.arch, entry.runner]));
  assert.equal(byArch.x64, 'macos-15-intel');
  assert.equal(byArch.arm64, 'macos-15');
  const commands = job.steps.map((step) => step.run || '').join('\n');
  assert.match(commands, /npm test/);
  assert.match(commands, /npm run test:speech-native/);
  assert.match(commands, /npm run verify:vision-ocr-package/);
  assert.match(commands, /npm run verify:speech-package/);
});

test('a packaged helper for the wrong architecture is rejected', () => {
  const wrong = () => { assertHelperArch({ helper: 'volyx-lens-vision-ocr', expectedArch: 'x86_64', runLipo: () => 'arm64' }); };
  assert.throws(wrong, /arm64/);
  const universal = () => { assertHelperArch({ helper: 'volyx-lens-vision-ocr', expectedArch: 'x86_64', runLipo: () => 'x86_64 arm64' }); };
  assert.doesNotThrow(universal);
  const matching = () => { assertHelperArch({ helper: 'volyx-lens-vision-ocr', expectedArch: 'arm64', runLipo: () => 'arm64' }); };
  assert.doesNotThrow(matching);
});

test('macOS package verification is scoped to the requested architecture directory', () => {
  const verifier = fs.readFileSync(path.join(root, 'scripts', 'verify-vision-ocr-package.js'), 'utf8');
  assert.match(verifier, /expectedArch === 'arm64' \? 'mac-arm64' : 'mac'/);
  assert.match(verifier, /findHelper\(packageDirectory, check\.name\)/);
  assert.doesNotMatch(verifier, /findHelper\(path\.join\(root, 'dist'\), check\.name\)/);
});

test('an unknown build architecture fails loudly instead of falling back to the host', () => {
  // The silent fallback is what put an arm64 helper in the Intel DMG.
  assert.throws(() => targetArchFor({ arch: 'universal' }), /Unsupported build architecture/);
  assert.throws(() => targetArchFor({ arch: 4 }), /Unsupported build architecture/);
  assert.throws(() => targetArchFor({ arch: 'ppc64' }), /Unsupported build architecture/);
});
