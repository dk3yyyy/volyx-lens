const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

const { validateUpdateMetadata } = require('../scripts/validate-update-metadata');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-update-metadata-'));
  const archivePath = path.join(dir, 'volyx-lens-0.3.0-mac-arm64.zip');
  const metadataPath = path.join(dir, 'latest-arm64-mac.yml');
  fs.writeFileSync(archivePath, 'signed archive fixture');
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(archivePath)).digest('base64');
  fs.writeFileSync(metadataPath, yaml.dump({
    version: '0.3.0',
    files: [{ url: path.basename(archivePath), sha512, size: fs.statSync(archivePath).size }],
    path: path.basename(archivePath),
    sha512,
  }));
  return { dir, archivePath, metadataPath };
}

test('release metadata must reference the exact architecture archive and SHA-512', () => {
  const item = fixture();
  assert.doesNotThrow(() => validateUpdateMetadata({
    metadataPath: item.metadataPath,
    archivePath: item.archivePath,
    expectedVersion: '0.3.0',
    expectedArch: 'arm64',
  }));
});

test('release metadata rejects a mismatched digest, version, or architecture', () => {
  const item = fixture();
  fs.appendFileSync(item.archivePath, 'tampered');
  assert.throws(() => validateUpdateMetadata({
    metadataPath: item.metadataPath,
    archivePath: item.archivePath,
    expectedVersion: '0.3.0',
    expectedArch: 'arm64',
  }), /SHA-512/);
  assert.throws(() => validateUpdateMetadata({
    metadataPath: item.metadataPath,
    archivePath: item.archivePath,
    expectedVersion: '0.4.0',
    expectedArch: 'arm64',
  }), /version/);
  assert.throws(() => validateUpdateMetadata({
    metadataPath: item.metadataPath,
    archivePath: item.archivePath,
    expectedVersion: '0.3.0',
    expectedArch: 'x64',
  }), /architecture/);
});

test('Windows and Linux release metadata validate their native installer format', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-update-metadata-win-'));
  const exePath = path.join(dir, 'volyx-lens-0.3.0-win-x64.exe');
  const exeMetadata = path.join(dir, 'latest.yml');
  fs.writeFileSync(exePath, 'nsis installer fixture');
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(exePath)).digest('base64');
  fs.writeFileSync(exeMetadata, yaml.dump({
    version: '0.3.0',
    files: [{ url: path.basename(exePath), sha512, size: fs.statSync(exePath).size }],
    path: path.basename(exePath),
    sha512,
  }));
  assert.doesNotThrow(() => validateUpdateMetadata({
    metadataPath: exeMetadata,
    archivePath: exePath,
    expectedVersion: '0.3.0',
    expectedArch: 'x64',
    platform: 'win32',
  }));
  assert.throws(() => validateUpdateMetadata({
    metadataPath: exeMetadata,
    archivePath: exePath,
    expectedVersion: '0.3.0',
    expectedArch: 'x64',
    platform: 'linux',
  }), /format/);

  const appImagePath = path.join(dir, 'volyx-lens-0.3.0-linux-x64.AppImage');
  const linuxMetadata = path.join(dir, 'latest-linux.yml');
  fs.writeFileSync(appImagePath, 'appimage fixture');
  const linuxSha512 = crypto.createHash('sha512').update(fs.readFileSync(appImagePath)).digest('base64');
  fs.writeFileSync(linuxMetadata, yaml.dump({
    version: '0.3.0',
    files: [{ url: path.basename(appImagePath), sha512: linuxSha512, size: fs.statSync(appImagePath).size }],
    path: path.basename(appImagePath),
    sha512: linuxSha512,
  }));
  assert.doesNotThrow(() => validateUpdateMetadata({
    metadataPath: linuxMetadata,
    archivePath: appImagePath,
    expectedVersion: '0.3.0',
    expectedArch: 'x64',
    platform: 'linux',
  }));
  assert.throws(() => validateUpdateMetadata({
    metadataPath: linuxMetadata,
    archivePath: appImagePath,
    expectedVersion: '0.3.0',
    expectedArch: 'arm64',
    platform: 'linux',
  }), /architecture/);
});
