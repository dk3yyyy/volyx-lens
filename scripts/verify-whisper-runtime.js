'use strict';

// Verifies that a packaged app really contains the pinned whisper.cpp server,
// not just that packaging was configured to copy one. Runs after
// electron-builder in the packaging jobs, where the extraResources step is the
// only thing standing between the manifest and a shipped offline engine.

const fs = require('node:fs');
const path = require('node:path');
const { runtimeFor, platformKey } = require('../src/whisper-runtime-manifest');
const { sha256File } = require('./prepare-whisper-runtime');

// Matches Contents/Resources/native (macOS) and resources/native (Windows,
// Linux), so the check only accepts the resource directory the sidecar reads.
const NATIVE_RESOURCES = /(?:^|[\\/])(?:Contents[\\/])?Resources[\\/]native[\\/]/i;

function findPackagedBinary(root, fileName) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const value = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findPackagedBinary(value, fileName);
      if (nested) return nested;
    } else if (entry.name === fileName && NATIVE_RESOURCES.test(value)) {
      return value;
    }
  }
  return null;
}

// Throws on any mismatch so the CLI exits non-zero; returns { supported: false }
// only when whisper.cpp publishes no prebuilt server for the target (macOS),
// which is a deliberate absence rather than a broken package.
function verifyPackagedWhisper({ distDir, platform = process.platform, arch = process.arch, runtime }) {
  const target = runtime === undefined ? runtimeFor({ platform, arch }) : runtime;
  if (!target) return { supported: false, target: platformKey({ platform, arch }) || `${platform}-${arch}` };

  const binary = findPackagedBinary(distDir, target.binaryName);
  if (!binary) {
    throw new Error(`The packaged app does not contain ${target.binaryName} under Resources/native (searched ${distDir}). The beforePack step did not provision it.`);
  }
  const stat = fs.statSync(binary);
  if (!stat.isFile()) throw new Error(`The packaged ${target.binaryName} is not a regular file: ${binary}`);
  if (platform !== 'win32') {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
    } catch {
      throw new Error(`The packaged ${target.binaryName} is not executable: ${binary}`);
    }
  }

  const actual = sha256File(binary);
  if (actual !== target.binarySha256) {
    throw new Error(`The packaged ${target.binaryName} does not match the pinned ${target.release} (${target.tag}) binary: expected ${target.binarySha256}, got ${actual}.`);
  }

  // whisper-server is dynamically linked, so the libraries must travel beside it
  // in the same directory or the executable cannot start on a user's machine.
  const directory = path.dirname(binary);
  for (const library of target.libraries) {
    const installed = path.join(directory, library.name);
    if (!fs.existsSync(installed)) {
      throw new Error(`The packaged whisper.cpp runtime is missing ${library.name} next to ${target.binaryName}.`);
    }
    if (sha256File(installed) !== library.sha256) {
      throw new Error(`The packaged whisper.cpp runtime has a mismatched ${library.name} next to ${target.binaryName}.`);
    }
  }

  return { supported: true, binary, target, libraries: target.libraries.length };
}

function parseArgs(argv = []) {
  const options = {};
  for (const argument of argv) {
    const match = /^--(platform|arch|dist)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}. Use --platform=<name>, --arch=<name> or --dist=<dir>.`);
    options[match[1]] = match[2];
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const distDir = path.resolve(options.dist || path.join(__dirname, '..', 'dist'));
    const result = verifyPackagedWhisper({ distDir, platform: options.platform, arch: options.arch });
    if (!result.supported) {
      console.log(`No prebuilt whisper.cpp server is published for ${result.target}; skipping packaged whisper-server verification.`);
      return;
    }
    console.log(`Packaged whisper-server verified: ${path.relative(process.cwd(), result.binary)} (${result.target.release} ${result.target.tag}, sha256 ${result.target.binarySha256}, ${result.libraries} runtime libraries).`);
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}

module.exports = { verifyPackagedWhisper, findPackagedBinary, parseArgs, main };

if (require.main === module) main();
