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
