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

test('the sidecar resolver and packaging agree on the bundled whisper-server binary', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const resolver = fs.readFileSync(path.join(root, 'src', 'whisper-sidecar.js'), 'utf8');

  const filter = pkg.build.extraResources[0].filter;
  assert.ok(filter.includes('whisper-server'), 'bundled whisper-server binary must be shippable via extraResources');
  assert.ok(filter.includes('whisper-server.exe'), 'bundled whisper-server.exe must be shippable via extraResources');

  assert.ok(
    /path\.join\(resourcesPath, 'native', platform === 'win32' \? 'whisper-server\.exe' : 'whisper-server'\)/.test(resolver),
    'resolver must look for the packaged whisper-server binary under resources/native',
  );
  assert.ok(
    /whisper-binaries/.test(resolver),
    'resolver must also look in the runtime-provisioned whisper-binaries directory',
  );
});

test('the provisioning downloader is pinned to a whisper.cpp release with real assets', () => {
  const downloader = fs.readFileSync(path.join(root, 'dev', 'whisper-binary.js'), 'utf8');
  assert.ok(!/whisper-macos-arm64\.tar\.gz/.test(downloader), 'dead macOS asset names must be removed');
  assert.ok(!/whisper-linux-x86_64\.tar\.gz/.test(downloader), 'dead Linux asset names must be removed');
  assert.match(downloader, /WHISPER_CPP_VERSION = 'v1\.9\.2'/, 'downloader must pin to a release that publishes server binaries');
});