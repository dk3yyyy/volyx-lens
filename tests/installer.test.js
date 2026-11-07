'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'website');
const sh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
const ps1 = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');

test('the macOS/Linux installer verifies the published digest before installing', () => {
  assert.match(sh, /releases\/download\/\$VERSION/);
  assert.match(sh, /shasum -a 256|sha256sum/);
  assert.match(sh, /-c "\$ASSET\.sha256"/);
  assert.match(sh, /xattr -cr/);
  assert.match(sh, /hdiutil attach/);
  assert.match(sh, /linux-arm64\.AppImage/);
  assert.match(sh, /mac-arm64-unsigned\.dmg/);
  assert.match(sh, /--dry-run/);
  assert.doesNotMatch(sh, /npm|node /, 'the installer must not depend on Node');
});

test('the Windows installer verifies the digest and runs the per-user installer', () => {
  assert.match(ps1, /releases\/download\/\$Version/);
  assert.match(ps1, /Get-FileHash -Algorithm SHA256/);
  assert.match(ps1, /Unblock-File/);
  assert.match(ps1, /ArgumentList "\/S"/);
  assert.match(ps1, /LOCALAPPDATA/);
  assert.doesNotMatch(ps1, /npm/, 'the installer must not depend on Node');
});
