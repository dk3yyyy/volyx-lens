#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function fail(message) {
  throw new Error(`Invalid update metadata: ${message}`);
}

const PLATFORM_EXTENSIONS = { darwin: '.zip', win32: '.exe', linux: '.AppImage' };

function validateUpdateMetadata({ metadataPath, archivePath, expectedVersion, expectedArch, platform = 'darwin' }) {
  if (!['arm64', 'x64'].includes(expectedArch)) fail('unsupported architecture');
  if (!Object.prototype.hasOwnProperty.call(PLATFORM_EXTENSIONS, platform)) fail('unsupported platform');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(expectedVersion || ''))) fail('invalid expected version');

  const archiveName = path.basename(archivePath);
  const expectedExtension = PLATFORM_EXTENSIONS[platform];
  if (!archiveName.endsWith(`-${expectedArch}${expectedExtension}`)) fail(`archive architecture or format does not match ${expectedArch}${expectedExtension}`);

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
  const [metadataPath, archivePath, expectedVersion, expectedArch, platform] = process.argv.slice(2);
  if (!metadataPath || !archivePath || !expectedVersion || !expectedArch) {
    console.error('Usage: validate-update-metadata <metadata.yml> <archive> <version> <arm64|x64> [darwin|win32|linux]');
    process.exit(2);
  }
  try {
    const result = validateUpdateMetadata({ metadataPath, archivePath, expectedVersion, expectedArch, platform });
    console.log(`Validated ${result.archive} update metadata for ${result.architecture} on ${platform || 'darwin'}.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { validateUpdateMetadata };
