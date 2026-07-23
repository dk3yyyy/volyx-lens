#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function fail(message) {
  throw new Error(`Invalid update metadata: ${message}`);
}

function validateUpdateMetadata({ metadataPath, archivePath, expectedVersion, expectedArch }) {
  if (!['arm64', 'x64'].includes(expectedArch)) fail('unsupported architecture');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(expectedVersion || ''))) fail('invalid expected version');

  const archiveName = path.basename(archivePath);
  if (!archiveName.endsWith(`-${expectedArch}.zip`)) fail('archive architecture does not match');

  const document = yaml.load(fs.readFileSync(metadataPath, 'utf8'), { json: true });
  if (!document || typeof document !== 'object' || Array.isArray(document)) fail('document must be an object');
  if (document.version !== expectedVersion) fail('version does not match the packaged application');
  if (!Array.isArray(document.files)) fail('files must be an array');

  const entry = document.files.find((item) => item && item.url === archiveName);
  if (!entry) fail('files do not reference the exact architecture archive');

  const archive = fs.readFileSync(archivePath);
  const digest = crypto.createHash('sha512').update(archive).digest('base64');
  if (entry.sha512 !== digest) fail('archive SHA-512 does not match');
  if (entry.size !== archive.length) fail('archive size does not match');
  if (document.path !== archiveName) fail('legacy path does not reference the exact archive');
  if (document.sha512 !== digest) fail('legacy SHA-512 does not match');

  return { version: document.version, architecture: expectedArch, archive: archiveName, sha512: digest };
}

if (require.main === module) {
  const [metadataPath, archivePath, expectedVersion, expectedArch] = process.argv.slice(2);
  if (!metadataPath || !archivePath || !expectedVersion || !expectedArch) {
    console.error('Usage: validate-update-metadata <metadata.yml> <archive.zip> <version> <arm64|x64>');
    process.exit(2);
  }
  try {
    const result = validateUpdateMetadata({ metadataPath, archivePath, expectedVersion, expectedArch });
    console.log(`Validated ${result.archive} update metadata for ${result.architecture}.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { validateUpdateMetadata };
