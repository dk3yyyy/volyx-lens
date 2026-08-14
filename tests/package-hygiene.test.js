'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function walkFiles(dir, acc = []) {
  const stat = fs.statSync(dir);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(dir)) walkFiles(path.join(dir, name), acc);
  } else {
    acc.push(path.relative(root, dir));
  }
  return acc;
}

test('packaged directories contain no backup or stray files', () => {
  const packaged = ['src', 'renderer'].flatMap((dir) => walkFiles(path.join(root, dir)));
  for (const file of packaged) {
    assert.ok(!/\.(bak|orig|tmp|old)$/.test(file), `${file} must not ship in the app`);
  }
});

test('whisper sidecar never resolves a missing ./whisper-sidecar-binary module', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'whisper-sidecar.js'), 'utf8');
  assert.ok(!source.includes("require.resolve('./whisper-sidecar-binary')"), 'the missing binary module must not be required at runtime');
  assert.match(source, /resolveWhisperBinary/, 'the sidecar resolves its binary through resolveWhisperBinary');
});

test('package.json build.files stays scoped to shipped directories', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const entry of pkg.build.files) {
    assert.ok(!entry.includes('dev/'), `scaffolding directory must not be packaged (got "${entry}")`);
  }
});