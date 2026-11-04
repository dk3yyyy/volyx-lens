'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root_dir = path.join(__dirname, '..');
const root = root_dir;
const pkg = require('../package.json');

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

test('the whisper runtime is provisioned by the pinned manifest, not the deleted dev scaffolding', () => {
  // dev/whisper-binary.js was Phase 5 scaffolding that could not load (it required
  // a package that is not installed) and pinned a release with no checksums. The
  // real provisioner is scripts/prepare-whisper-runtime.js driven by the manifest.
  assert.equal(fs.existsSync(path.join(root, 'dev', 'whisper-binary.js')), false, 'dead scaffolding is gone');
  const manifest = require('../src/whisper-runtime-manifest');
  for (const [target, entry] of Object.entries(manifest.MANIFEST)) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${target} pins an archive checksum`);
    assert.match(entry.assetUrl, /^https:\/\//, `${target} downloads over https`);
  }
  assert.match(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), /scripts\/before-pack\.js/, 'packaging runs the provisioner');
});
test('no module requires a package that package.json does not declare', () => {
  // whisper-sidecar required node-fetch, which only resolved because an old SDK
  // happened to depend on it. The openai 4 to 7 bump removed it and the app broke
  // at load time, which no unit test noticed because that file was not imported.
  const builtins = new Set(require('node:module').builtinModules);
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!full.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
        const name = match[2];
        if (name.startsWith('.') || name.startsWith('node:') || builtins.has(name)) continue;
        const root = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
        if (!declared.has(root)) offenders.push(`${path.relative(root_dir, full)} requires ${root}`);
      }
    }
  };
  walk(root_dir);
  assert.deepEqual(offenders.sort(), [], `undeclared requires:\n${offenders.join('\n')}`);
});
