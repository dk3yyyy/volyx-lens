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

test('the launch check only runs an AppImage on a matching runner', () => {
  // The hosted x64 runner cannot execute an arm64 AppImage, so the build must not
  // be failed by an Exec format error after packaging succeeded.
  assert.match(workflow, /RUNNER_ARCH="\$\(uname -m\)"/);
  assert.match(workflow, /Skipping launch check/);
});

test('the workflow never reads a secret in an if expression', () => {
  assert.doesNotMatch(workflow, /if:\s*\$\{\{\s*secrets\./);
});
