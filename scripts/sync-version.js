'use strict';

// Keep the hand-written release references in the README and landing page
// aligned with package.json. The negative lookarounds keep 127.0.0.1 and other
// dotted numbers out of the replacement.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`package.json version is not a release version: ${version || '(empty)'}`);
  process.exit(1);
}

const files = ['website/index.html', 'website/script.js', 'README.md'];
const pattern = /(?<![\d.])0\.\d+\.\d+(?![\d.])/g;
const check = process.argv.includes('--check');
let changed = 0;

for (const relative of files) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(pattern, version);
  if (after !== before) {
    changed += 1;
    if (check) {
      console.error(`${relative}: version does not match package.json (${version})`);
    } else {
      fs.writeFileSync(file, after);
      console.log(`${relative}: synced to ${version}`);
    }
  }
}

if (check && changed) process.exit(1);
if (check) console.log(`version references match ${version}`);
