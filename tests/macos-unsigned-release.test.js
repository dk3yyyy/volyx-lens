'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-macos-unsigned.yml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('the unsigned macOS build is reproducible from a workflow', () => {
  assert.match(workflow, /^name: Unsigned macOS build/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tag:/);
});

test('it builds both published architectures with the published names', () => {
  assert.match(workflow, /arch: arm64/);
  assert.match(workflow, /arch: x64/);
  assert.match(workflow, /volyx-lens-\$\{VERSION\}-mac-\$\{ARCH\}-unsigned\.dmg/);
  assert.match(workflow, /volyx-lens-\$\{VERSION\}-mac-\$\{ARCH\}-unsigned\.zip/);
});

test('every artifact carries a checksum, an SBOM and a provenance attestation', () => {
  assert.match(workflow, /shasum -a 256/);
  assert.match(workflow, /npm sbom --sbom-format cyclonedx/);
  assert.match(workflow, /actions\/attest-build-provenance@v2/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /id-token: write/);
});

test('an unsigned build does not publish updater metadata', () => {
  assert.match(workflow, /test ! -f dist\/latest-mac\.yml/);
});

test('the README points at the workflow that produces the unsigned DMG', () => {
  assert.match(readme, /build-macos-unsigned\.yml/);
  assert.match(readme, /build-provenance attestation/);
});

test('the workflow never reads a secret in an if expression', () => {
  assert.doesNotMatch(workflow, /if:\s*\$\{\{\s*secrets\./);
});
