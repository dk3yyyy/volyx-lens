'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-linux-unsigned.yml'), 'utf8');

test('the unsigned Linux build is reproducible from a workflow', () => {
  assert.match(workflow, /^name: Unsigned Linux build/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /arch: x64/);
  assert.match(workflow, /arch: arm64/);
});

test('it builds the AppImage without update metadata', () => {
  assert.match(workflow, /electron-builder --linux AppImage/);
  assert.match(workflow, /rm -f dist\/latest\*\.yml/);
  assert.match(workflow, /test -z "\$\(ls dist\/latest\*\.yml/);
});

test('the AppImage is smoke launched, hashed, attested and shipped with an SBOM', () => {
  assert.match(workflow, /VOLYX_LENS_RENDERER_READY/);
  assert.match(workflow, /createHash\('sha256'\)/);
  assert.match(workflow, /npm sbom --sbom-format cyclonedx/);
  assert.match(workflow, /actions\/attest-build-provenance@v2/);
  assert.match(workflow, /attestations: write/);
});

test('each AppImage is built and smoke launched on a matching native runner', () => {
  assert.match(workflow, /runner: ubuntu-24\.04-arm/);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.doesNotMatch(workflow, /Skipping launch check/);
  assert.match(workflow, /grep -q 'VOLYX_LENS_RENDERER_READY'/);
});

test('the Linux release uses native runners and fails unless the renderer becomes ready', () => {
  const release = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-linux.yml'), 'utf8');
  assert.match(release, /runner: ubuntu-22\.04-arm/);
  assert.match(release, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(release, /timeout 120 xvfb-run -a/);
  assert.match(release, /grep -q 'VOLYX_LENS_RENDERER_READY'/);
  assert.match(release, /npm run verify:speech-package/);
});

test('the workflow never reads a secret in an if expression', () => {
  assert.doesNotMatch(workflow, /if:\s*\$\{\{\s*secrets\./);
});
