'use strict';

// Downloads the pinned whisper.cpp server into native-bin/ so electron-builder
// can ship it. The binary is provisioned at packaging time, not at runtime,
// because the app must start offline and a release build has no installer hook
// that could fetch a 10 MB executable through a user's firewall.
//
// Every byte is verified against src/whisper-runtime-manifest.js before the file
// is installed: a mirror or a TLS-terminating proxy cannot substitute a different
// executable for the one that was audited.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MANIFEST, runtimeFor, platformKey } = require('../src/whisper-runtime-manifest');

const SKIP_ENV = 'VOLYX_LENS_SKIP_WHISPER_RUNTIME';
// Real archives are 4-11 MB. A redirect page, an HTML error body or a corrupted
// download is orders of magnitude smaller or larger, so the cap catches the
// obvious cases before they reach disk.
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const SUPPORTED_ARCHIVES = new Set(['zip', 'tar.gz']);

// Hash a file without loading it into memory.
function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isPinnedFile(filePath, expectedSha256) {
  try {
    if (!expectedSha256 || !fs.existsSync(filePath)) return false;
    return sha256File(filePath) === String(expectedSha256).toLowerCase();
  } catch {
    return false;
  }
}

// A worktree that built Linux and then macOS would otherwise leave the Linux
// executable in native-bin/, and extraResources would copy it into the Mac app.
// The resolver only checks that a whisper-server file exists, so the Mac build
// would then advertise an offline engine that cannot spawn. Removing the files a
// previous pack staged keeps every unsupported package honest.
function removeStaleRuntimeFiles(directory) {
  const names = new Set();
  for (const entry of Object.values(MANIFEST)) {
    names.add(entry.binaryName);
    for (const library of entry.libraries) names.add(library.name);
  }
  const removed = [];
  for (const name of names) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed.push(name);
    }
  }
  return removed;
}

function displayPath(file, projectDir) {
  const relative = path.relative(projectDir, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return relative;
}

// The extraction commands are tried in order; the first one present on the host
// wins. Windows 10+ ships bsdtar (which reads zip and tar.gz), Linux ships
// unzip and GNU tar, macOS ships both unzip and bsdtar.
function extractionCommands({ archive, archivePath, destination, platform = process.platform }) {
  // Windows ships bsdtar, and it reads a "D:\\..." operand as a remote host, which
  // fails with "Cannot connect to D". It does not support GNU tar's --force-local,
  // so the archive is named relatively and tar runs from its directory instead.
  const windowsSafe = platform === 'win32';
  const archiveArg = windowsSafe ? path.basename(archivePath) : archivePath;
  const cwd = windowsSafe ? path.dirname(archivePath) : undefined;
  const unzip = { command: 'unzip', args: ['-q', '-o', archiveArg, '-d', destination], cwd };
  const untar = { command: 'tar', args: ['-xzf', archiveArg, '-C', destination], cwd };
  const bsdtar = { command: 'tar', args: ['-xf', archiveArg, '-C', destination], cwd };
  if (archive === 'tar.gz') return [untar, bsdtar];
  if (archive === 'zip') return platform === 'win32' ? [bsdtar, unzip] : [unzip, bsdtar];
  throw new Error(`Unsupported whisper.cpp archive type: ${archive}.`);
}

function runExtractor({ command, args, cwd }) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, cwd });
  if (result.error && result.error.code === 'ENOENT') return false;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 2000);
    throw new Error(`Could not extract the whisper.cpp archive with ${command}.${detail ? `\n${detail}` : ''}`);
  }
  return true;
}

// A zip is unpacked in-process. `tar` is not portable enough to rely on here: the
// Windows release job runs under Git Bash, where `tar` is GNU tar (it cannot read
// zip at all and prints "This does not look like a tar archive"), while the test
// job resolves Windows' bsdtar, which reads a "D:\..." operand as a remote host.
// jszip is already a runtime dependency, so neither quirk can break packaging.
async function extractZipInProcess({ archivePath, destination }) {
  const JSZip = require('jszip');
  const data = await fs.promises.readFile(archivePath);
  const zip = await JSZip.loadAsync(data);
  for (const [name, entry] of Object.entries(zip.files)) {
    const target = resolveInsideArchive(destination, name);
    if (entry.dir) {
      await fs.promises.mkdir(target, { recursive: true });
      continue;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, await entry.async('nodebuffer'), { mode: 0o755 });
  }
}

async function extractArchive({ runtime, archivePath, destination, platform }) {
  if (runtime.archive === 'zip') {
    await extractZipInProcess({ archivePath, destination });
    return;
  }
  const commands = extractionCommands({ archive: runtime.archive, archivePath, destination, platform });
  for (const candidate of commands) {
    if (runExtractor(candidate)) return;
  }
  const names = commands.map((candidate) => candidate.command).join(' or ');
  throw new Error(`No extractor available: install ${names} to unpack ${runtime.asset}.`);
}

// Archive members may contain ".." or absolute paths; only paths that stay inside
// the extraction directory are ever touched.
function resolveInsideArchive(root, relativePath) {
  // Resolve the root first: on Windows a POSIX-style root ("/tmp/x") resolves to
  // a drive-qualified path, so comparing it against the un-normalised root
  // rejected every entry, including safe ones.
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, relativePath);
  const rootWithSeparator = absoluteRoot.endsWith(path.sep) ? absoluteRoot : `${absoluteRoot}${path.sep}`;
  if (resolved !== absoluteRoot && !resolved.startsWith(rootWithSeparator)) {
    throw new Error(`The whisper.cpp archive contains an unsafe path: ${relativePath}.`);
  }
  return resolved;
}

function responseHeader(response, name) {
  const headers = response && response.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  return String(headers[name] || '');
}

async function downloadArchive({ runtime, cacheDir, fetchImpl }) {
  const cacheFile = path.join(cacheDir, runtime.asset);
  if (isPinnedFile(cacheFile, runtime.sha256)) return cacheFile;
  // A cached file with the wrong digest is not the audited asset; delete it so a
  // corrupted cache cannot be reused on the next run.
  fs.rmSync(cacheFile, { force: true });
  await fs.promises.mkdir(cacheDir, { recursive: true, mode: 0o700 });

  const partial = `${cacheFile}.part`;
  fs.rmSync(partial, { force: true });
  try {
    const response = await fetchImpl(runtime.assetUrl, {
      redirect: 'follow',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) : undefined,
    });
    if (!response || response.ok !== true) {
      const status = response && response.status ? `HTTP ${response.status}` : 'no response';
      throw new Error(`Could not download the whisper.cpp archive ${runtime.assetUrl}: ${status}.`);
    }
    const declaredSize = Number(responseHeader(response, 'content-length') || 0);
    if (declaredSize > MAX_ARCHIVE_BYTES) {
      throw new Error(`The whisper.cpp archive ${runtime.asset} is larger than the ${MAX_ARCHIVE_BYTES} byte limit.`);
    }
    if (typeof response.arrayBuffer !== 'function') {
      throw new Error(`The response for ${runtime.assetUrl} has no body to read.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) {
      throw new Error(`The whisper.cpp archive ${runtime.asset} has an unusable size: ${bytes.length} bytes.`);
    }
    await fs.promises.writeFile(partial, bytes, { mode: 0o600 });
    const actual = sha256Buffer(bytes);
    if (actual !== String(runtime.sha256).toLowerCase()) {
      throw new Error(
        `The whisper.cpp archive ${runtime.asset} failed SHA-256 verification: expected ${runtime.sha256}, got ${actual}. The download was discarded.`,
      );
    }
    await fs.promises.rename(partial, cacheFile);
    return cacheFile;
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

// The files the server needs beside it: the executable plus every shared library
// the archive ships for it (whisper-server is dynamically linked). Libraries are
// installed first so a run interrupted midway never leaves a server that cannot
// start next to a missing dependency.
function runtimeFiles(runtime) {
  return [
    ...runtime.libraries.map((library) => ({ source: library.path, name: library.name, sha256: library.sha256 })),
    { source: runtime.binary, name: runtime.binaryName, sha256: runtime.binarySha256 },
  ];
}

// Every installed file is checked, so an install interrupted between two files is
// repaired instead of being mistaken for a complete one.
function installedBinaryPath({ directory, runtime }) {
  const binaryPath = path.join(directory, runtime.binaryName);
  for (const file of runtimeFiles(runtime)) {
    if (!isPinnedFile(path.join(directory, file.name), file.sha256)) return null;
  }
  return binaryPath;
}

async function installFile({ source, destination }) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fs.promises.copyFile(source, temporary);
    await fs.promises.chmod(temporary, 0o755);
    // Windows refuses to rename over an existing file in some filesystems, and a
    // mismatched binary is being replaced anyway.
    fs.rmSync(destination, { force: true });
    await fs.promises.rename(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function verifyExtractedFiles({ extractDir, runtime }) {
  const files = [];
  for (const file of runtimeFiles(runtime)) {
    const extracted = resolveInsideArchive(extractDir, file.source);
    if (!fs.existsSync(extracted)) {
      throw new Error(`The whisper.cpp archive ${runtime.asset} does not contain ${file.source}.`);
    }
    const actual = sha256File(extracted);
    if (actual !== String(file.sha256).toLowerCase()) {
      throw new Error(`The whisper.cpp archive ${runtime.asset} produced a mismatched ${path.basename(file.source)}: expected ${file.sha256}, got ${actual}.`);
    }
    files.push({ extracted, ...file });
  }
  return files;
}

async function prepareWhisperRuntime({
  platform = process.platform,
  arch = process.arch,
  projectDir = path.resolve(__dirname, '..'),
  cacheDir = '',
  fetchImpl = globalThis.fetch,
  runtime,
  log = (message) => console.log(message),
} = {}) {
  if (String(process.env[SKIP_ENV] || '').trim() === '1') {
    log(`whisper-server: skipped because ${SKIP_ENV}=1.`);
    return { status: 'skipped', reason: `${SKIP_ENV}=1`, binary: null };
  }

  const target = runtime === undefined ? runtimeFor({ platform, arch }) : runtime;
  if (!target) {
    const key = platformKey({ platform, arch }) || `${platform}-${arch}`;
    const removed = removeStaleRuntimeFiles(path.join(projectDir, 'native-bin'));
    const stale = removed.length ? ` Removed ${removed.length} whisper runtime file(s) staged by a previous pack.` : '';
    log(`whisper-server: no prebuilt whisper.cpp server is published for ${key}; offline transcription stays unavailable for this target.${stale}`);
    return { status: 'unsupported', target: key, binary: null, removed };
  }
  if (!SUPPORTED_ARCHIVES.has(target.archive)) {
    throw new Error(`Unsupported whisper.cpp archive type for ${target.asset}: ${target.archive}.`);
  }

  const key = platformKey({ platform: target.platform || platform, arch: target.arch || arch }) || `${target.platform}-${target.arch}`;
  const binariesDir = path.join(projectDir, 'native-bin');
  const installed = installedBinaryPath({ directory: binariesDir, runtime: target });
  if (installed) {
    log(`whisper-server: ${target.release} (${target.tag}) is already installed for ${key} at ${displayPath(installed, projectDir)}.`);
    return { status: 'up-to-date', binary: installed, target: key, version: target.release, tag: target.tag, sha256: target.binarySha256 };
  }

  const resolvedCacheDir = cacheDir || path.join(binariesDir, '.whisper-runtime-cache');
  const archivePath = await downloadArchive({ runtime: target, cacheDir: resolvedCacheDir, fetchImpl });
  const extractDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'volyx-whisper-runtime-'));
  try {
    await extractArchive({ runtime: target, archivePath, destination: extractDir, platform });
    const files = verifyExtractedFiles({ extractDir, runtime: target });
    for (const file of files) {
      await installFile({ source: file.extracted, destination: path.join(binariesDir, file.name) });
    }
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  const binary = path.join(binariesDir, target.binaryName);
  log(`whisper-server: installed ${target.release} (${target.tag}) for ${key} at ${displayPath(binary, projectDir)} (sha256 ${target.binarySha256}).`);
  return { status: 'installed', binary, target: key, version: target.release, tag: target.tag, sha256: target.binarySha256 };
}

module.exports = {
  SKIP_ENV,
  extractZipInProcess,
  removeStaleRuntimeFiles,
  MAX_ARCHIVE_BYTES,
  prepareWhisperRuntime,
  sha256File,
  sha256Buffer,
  extractionCommands,
  resolveInsideArchive,
  installedBinaryPath,
  runtimeFiles,
};
