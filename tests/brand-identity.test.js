const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const textExtensions = new Set(['.js', '.json', '.md', '.html', '.css', '.yml', '.yaml', '.plist', '.swift']);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', '__MACOSX']);
const ignoredFiles = new Set(['package-lock.json']);
const retiredIdentifier = String.fromCharCode(99, 117, 101);

function projectTextFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) projectTextFiles(target, files);
    else if (!ignoredFiles.has(entry.name) && textExtensions.has(path.extname(entry.name))) files.push(target);
  }
  return files;
}

test('source uses only the canonical Volyx Lens identity', () => {
  const findings = [];
  for (const file of projectTextFiles(root)) {
    const relative = path.relative(root, file);
    const text = fs.readFileSync(file, 'utf8');
    if (text.toLowerCase().includes(retiredIdentifier)) findings.push(relative);
  }
  assert.deepEqual(findings, []);
});

test('renderer and preload share the canonical bridge name', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  assert.match(preload, /exposeInMainWorld\('volyxLens'/);
  assert.match(renderer, /const volyxLens = window\.volyxLens/);
  assert.doesNotMatch(renderer, new RegExp(`\\b${retiredIdentifier}\\.`, 'i'));
});

test('repository declares the PolyForm noncommercial license and commercial contact', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const license = fs.readFileSync(path.join(root, 'LICENSE.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE.md');
  assert.ok(pkg.build.files.includes('LICENSE.md'));
  assert.equal(lock.packages[''].license, 'SEE LICENSE IN LICENSE.md');
  assert.match(license, /^# PolyForm Noncommercial License 1\.0\.0/m);
  assert.match(license, /https:\/\/polyformproject\.org\/licenses\/noncommercial\/1\.0\.0/);
  assert.match(license, /Required Notice: Copyright 2026 Joshua Nwachinemere/);
  assert.match(readme, /source-available under the \[PolyForm Noncommercial License 1\.0\.0\]/);
  assert.match(readme, /Commercial licensing: joshua@volyxai\.com/);
});
