#!/usr/bin/env node
'use strict';

// Check the set of files a release job is about to publish.
//
// Exists because `gh release upload --clobber` happily replaces a signed
// installer and its latest.yml with an unsigned rebuild, or leaves two versions
// of the same AppImage on the release. The rules live in src/release-assets.js;
// this wrapper only lists a directory, prints the problems, and sets the exit
// code so `set -euo pipefail` steps fail before the upload runs.

const fs = require('node:fs');
const path = require('node:path');
const { verifyReleaseAssets } = require('../src/release-assets');

const USAGE = `Usage: node scripts/verify-release-assets.js --platform <win32|linux|darwin> --dir <dir> [--signed] [--arch <x64|arm64>] [--no-metadata]

  --signed       the build is signed and publishes updater metadata
  --arch         architecture to check; derived from the published file names when omitted
  --no-metadata  assert the directory publishes no latest*.yml (a build that intentionally ships none)

Exit codes: 0 verified, 1 the published set is wrong, 2 bad usage or unreadable directory.`;

function parseArgs(argv) {
  const options = { platform: null, dir: null, arch: null, signed: false, noMetadata: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--platform') options.platform = value();
    else if (arg === '--dir') options.dir = value();
    else if (arg === '--arch') options.arch = value();
    else if (arg === '--signed') options.signed = true;
    else if (arg === '--no-metadata') options.noMetadata = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function listFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (!options.platform || !options.dir) {
    console.error('Both --platform and --dir are required.');
    console.error(USAGE);
    return 2;
  }

  let files;
  try {
    files = listFiles(path.resolve(options.dir));
  } catch (error) {
    console.error(`Cannot read directory ${options.dir}: ${error.message}`);
    return 2;
  }

  const label = `${options.platform}${options.arch ? `/${options.arch}` : ''} (${options.signed ? 'signed' : 'unsigned'}${options.noMetadata ? ', no metadata' : ''})`;
  console.log(`Checking ${files.length} file${files.length === 1 ? '' : 's'} in ${options.dir} for ${label}:`);
  for (const name of files) console.log(`  ${name}`);

  const result = verifyReleaseAssets({
    platform: options.platform,
    files,
    signed: options.signed,
    arch: options.arch,
    metadata: options.noMetadata ? 'none' : 'required',
  });

  if (result.ok) {
    console.log(`Release assets verified for ${label}.`);
    return 0;
  }
  console.error(`Release asset verification failed for ${label}:`);
  for (const problem of result.problems) console.error(`  - ${problem}`);
  return 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, parseArgs };
