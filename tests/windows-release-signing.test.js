'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const workflow = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'release-windows.yml'), 'utf8'));
const steps = workflow.jobs['build-sign'].steps;

function step(name) {
  const found = steps.find((entry) => entry.name === name);
  assert.ok(found, `the "${name}" step exists`);
  return found;
}

test('an installer advertises self-update only when a certificate will sign it', () => {
  const build = step('Build NSIS installer').run;
  // electron-updater trusts nothing it cannot verify, so an unsigned installer must
  // not ship the flag that turns the updater on (README: metadata is consumed only
  // by signed release builds).
  const guard = build.indexOf('if [ -n "$CSC_LINK_VALUE" ]');
  const flag = build.indexOf('volyxReleaseBuild=true');
  assert.ok(guard >= 0, 'the release build is gated on a signing certificate');
  assert.ok(flag > guard, 'the self-update flag is set inside that guard');
});

test('an unsigned installer publishes no updater metadata', () => {
  const build = step('Build NSIS installer').run;
  assert.match(build, /rm -f dist\/latest\.yml/);
  assert.match(build, /test ! -f dist\/latest\.yml/);
  assert.match(step('Build NSIS installer').env.CSC_LINK_VALUE, /WINDOWS_CSC_LINK/);
});

test('updater metadata is validated when present and its absence is asserted when unsigned', () => {
  const checksum = step('Generate checksum and SBOM');
  assert.match(checksum.run, /if \[ -f "dist\/latest\.yml" \]/);
  assert.match(checksum.run, /validate-update-metadata\.js/);
  assert.match(checksum.run, /test -z "\$CSC_LINK_VALUE"/);
  assert.match(checksum.env.CSC_LINK_VALUE, /WINDOWS_CSC_LINK/);
});

test('the signature step no longer claims an unsigned build can auto-update', () => {
  const verify = step('Verify the installer signature').run;
  assert.doesNotMatch(verify, /updates rest on TLS/);
  assert.match(verify, /no latest\.yml/);
});
