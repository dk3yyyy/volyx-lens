'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-windows-unsigned.yml'), 'utf8');

test('the unsigned Windows build is reproducible from a workflow', () => {
  assert.match(workflow, /^name: Unsigned Windows build/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on: windows-latest/);
});

test('it builds without a signing certificate', () => {
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
  assert.doesNotMatch(workflow, /CSC_LINK/);
  assert.doesNotMatch(workflow, /if:\s*\$\{\{\s*secrets\./);
});

test('the installer carries a checksum and an SBOM', () => {
  assert.match(workflow, /createHash\('sha256'\)/);
  assert.match(workflow, /npm sbom --sbom-format cyclonedx/);
  assert.match(workflow, /volyx-lens-\*-win-x64\.exe\.sha256/);
});

test('an unsigned build publishes no updater metadata and is attested', () => {
  assert.match(workflow, /rm -f dist\/latest\.yml/);
  assert.match(workflow, /test ! -f dist\/latest\.yml/);
  assert.match(workflow, /actions\/attest-build-provenance@v2/);
  assert.match(workflow, /attestations: write/);
});
