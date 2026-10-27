'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release-windows.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('the Windows release records who signs the build', () => {
  // electron-updater only verifies an update's signer when publisherName is set, so it
  // is taken from the certificate rather than typed by hand (VR-25).
  assert.match(workflow, /name: Pin the update publisher to the signing certificate/);
  assert.match(workflow, /Get-PfxCertificate/);
  assert.match(workflow, /npm pkg set "build\.win\.publisherName=\$\(\$cert\.Subject\)"/);
  // Only when a certificate exists, so repositories without the secret are unaffected.
  assert.match(workflow, /if: \$\{\{ secrets\.WINDOWS_CSC_LINK != '' \}\}/);
});

test('a configured certificate has to produce a valid signature', () => {
  assert.match(workflow, /name: Verify the installer signature/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /if \(\$signature\.Status -ne 'Valid'\)/);
  assert.match(workflow, /Signing certificate is configured, so this build must be signed|must be signed/);
});

test('an unsigned Windows build says so instead of pretending', () => {
  assert.match(workflow, /No signing certificate configured/);
  assert.match(workflow, /rest on TLS plus the SHA-512/);
});

test('package.json carries no invented publisher', () => {
  // A guessed subject would make electron-updater reject genuine updates.
  const win = pkg.build && pkg.build.win ? pkg.build.win : {};
  if (Object.hasOwn(win, 'publisherName')) {
    assert.match(String(win.publisherName), /CN=/, 'a pinned publisher must be a real certificate subject');
  }
});
