'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  RELEASE_VERSION,
  RELEASE_TAG,
  MANIFEST,
  platformKey,
  runtimeFor,
} = require('../src/whisper-runtime-manifest');
const {
  prepareWhisperRuntime,
  extractionCommands,
  resolveInsideArchive,
} = require('../scripts/prepare-whisper-runtime');
const { verifyPackagedWhisper, findPackagedBinary, parseArgs } = require('../scripts/verify-whisper-runtime');

const root = path.join(__dirname, '..');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function temporaryDir(prefix = 'volyx-whisper-test-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeTarGz({ binaryPath, contents, libraries = [] }) {
  const stage = temporaryDir('volyx-whisper-archive-');
  const fixture = path.join(stage, 'fixture');
  const binary = path.join(fixture, binaryPath);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, contents, { mode: 0o755 });
  for (const library of libraries) {
    const target = path.join(fixture, library.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, library.contents, { mode: 0o755 });
  }
  const archive = path.join(stage, 'fixture.tar.gz');
  const result = spawnSync('tar', ['-czf', archive, '-C', stage, 'fixture'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `fixture archive was created (tar said: ${String(result.stderr || '').trim()})`);
  return { archive, bytes: fs.readFileSync(archive) };
}

function runtimeForFixture({ bytes, binaryPath = 'whisper-server', libraries = [] }) {
  return {
    platform: 'linux',
    arch: 'x64',
    release: 'v0.0.0-test',
    tag: 'btest',
    asset: 'fixture.tar.gz',
    assetUrl: 'https://example.invalid/fixture.tar.gz',
    sha256: sha256(bytes),
    archive: 'tar.gz',
    binary: `fixture/${binaryPath}`,
    binaryName: 'whisper-server',
    binarySha256: sha256(Buffer.from('fixture server bytes')),
    libraries,
  };
}

function stubFetch(bytes, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.length) },
      arrayBuffer: async () => bytes,
    };
  };
}

test('manifest pins every supported target with an https asset and a full SHA-256', () => {
  assert.match(RELEASE_VERSION, /^v\d+\.\d+\.\d+$/, 'the release version is a real tag');
  assert.match(RELEASE_TAG, /^b\d+$/, 'the nightly tag hosts the assets');
  assert.deepEqual(Object.keys(MANIFEST).sort(), ['linux-arm64', 'linux-x64', 'win32-x64']);
  for (const [key, entry] of Object.entries(MANIFEST)) {
    assert.equal(key, `${entry.platform}-${entry.arch}`, `${key} is keyed by platform-arch`);
    assert.equal(entry.release, RELEASE_VERSION);
    assert.equal(entry.tag, RELEASE_TAG);
    assert.match(entry.assetUrl, /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b\d+\//, `${key} downloads over https`);
    assert.ok(entry.assetUrl.endsWith(`/${entry.asset}`), `${key} asset URL names the pinned archive`);
    assert.match(entry.assetApiUrl, /^https:\/\/api\.github\.com\/repos\/ggml-org\/whisper\.cpp\/releases\/assets\/\d+$/, `${key} has an API asset fallback`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${key} archive is pinned by SHA-256`);
    assert.ok(['zip', 'tar.gz'].includes(entry.archive), `${key} uses a supported archive type`);
    assert.ok(entry.binary.endsWith(entry.binaryName), `${key} archive path ends with the shipped binary name`);
    assert.ok(entry.binary.includes('whisper-server'), `${key} archive path points at whisper-server`);
    assert.match(entry.binarySha256, /^[0-9a-f]{64}$/, `${key} binary is pinned by SHA-256`);
    for (const library of entry.libraries) {
      assert.ok(library.path.includes(path.basename(library.name)), `${key} library ${library.name} comes from the archive`);
      assert.match(library.sha256, /^[0-9a-f]{64}$/, `${key} library ${library.name} is pinned by SHA-256`);
    }
    assert.equal(runtimeFor({ platform: entry.platform, arch: entry.arch }), entry, `${key} resolves through runtimeFor`);
  }
});

test('runtimeFor rejects darwin and every target whisper.cpp publishes no server for', () => {
  // whisper.cpp ships a macOS XCFramework (a library), never a whisper-server, so
  // macOS must stay explicitly unsupported instead of silently pointing at a file
  // that cannot exist.
  assert.equal(runtimeFor({ platform: 'darwin', arch: 'arm64' }), null);
  assert.equal(runtimeFor({ platform: 'darwin', arch: 'x64' }), null);
  assert.equal(runtimeFor({ platform: 'win32', arch: 'arm64' }), null);
  assert.equal(runtimeFor({ platform: 'linux', arch: 'ia32' }), null);
  assert.equal(runtimeFor({ platform: 'freebsd', arch: 'x64' }), null);
  assert.equal(runtimeFor({}), null);
});

test('platformKey accepts the spellings electron-builder and os.arch produce', () => {
  assert.equal(platformKey({ platform: 'linux', arch: 'x64' }), 'linux-x64');
  assert.equal(platformKey({ platform: 'linux', arch: 'x86_64' }), 'linux-x64');
  assert.equal(platformKey({ platform: 'linux', arch: 1 }), 'linux-x64');
  assert.equal(platformKey({ platform: 'linux', arch: 'aarch64' }), 'linux-arm64');
  assert.equal(platformKey({ platform: 'linux', arch: 3 }), 'linux-arm64');
  assert.equal(platformKey({ platform: 'linux', arch: 'mips' }), null);
});

test('a wrong archive hash is rejected and leaves no binary behind', async () => {
  const { bytes } = makeTarGz({ binaryPath: 'whisper-server', contents: 'fixture server bytes' });
  const projectDir = temporaryDir();
  const runtime = { ...runtimeForFixture({ bytes }), sha256: '0'.repeat(64) };
  const logs = [];
  await assert.rejects(
    prepareWhisperRuntime({ projectDir, cacheDir: path.join(projectDir, 'cache'), fetchImpl: stubFetch(bytes), runtime, log: (line) => logs.push(line) }),
    /SHA-256/,
  );
  assert.equal(fs.existsSync(path.join(projectDir, 'native-bin', 'whisper-server')), false, 'no binary is installed');
  assert.deepEqual(logs, [], 'a failed run does not claim success');
  const leftovers = fs.existsSync(path.join(projectDir, 'native-bin'))
    ? fs.readdirSync(path.join(projectDir, 'native-bin')).filter((name) => name.endsWith('.part') || name.includes('.tmp-'))
    : [];
  assert.deepEqual(leftovers, [], 'no partial file is left in place');
});

test('falls back to the GitHub API asset endpoint when the download URL returns 504', async () => {
  const { bytes } = makeTarGz({ binaryPath: 'whisper-server', contents: 'fixture server bytes' });
  const projectDir = temporaryDir();
  const runtime = {
    ...runtimeForFixture({ bytes }),
    assetApiUrl: 'https://api.example.invalid/repos/ggml-org/whisper.cpp/releases/assets/1',
  };
  const calls = [];
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === runtime.assetUrl) {
      return { ok: false, status: 504, headers: { get: () => '0' } };
    }
    return stubFetch(bytes)(url, options);
  };

  const result = await prepareWhisperRuntime({
    projectDir,
    cacheDir: path.join(projectDir, 'cache'),
    fetchImpl,
    runtime,
    log: () => {},
  });
  assert.equal(result.status, 'installed');
  assert.deepEqual(calls.map((call) => call.url), [runtime.assetUrl, runtime.assetUrl, runtime.assetApiUrl]);
  assert.equal(calls[2].options.headers.Accept, 'application/octet-stream');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer test-token');
  assert.equal(fs.existsSync(path.join(projectDir, 'native-bin', 'whisper-server')), true);
  if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousToken;
});

test('a verified archive installs an executable binary and the next run is a no-op', async () => {
  const contents = Buffer.from('fixture server bytes');
  const { bytes } = makeTarGz({ binaryPath: 'whisper-server', contents });
  const projectDir = temporaryDir();
  const runtime = runtimeForFixture({ bytes });
  const calls = [];
  const logs = [];

  const first = await prepareWhisperRuntime({
    projectDir,
    cacheDir: path.join(projectDir, 'cache'),
    fetchImpl: stubFetch(bytes, calls),
    runtime,
    log: (line) => logs.push(line),
  });
  assert.equal(first.status, 'installed');
  assert.equal(logs.length, 1, 'one line explains what happened');
  const installed = path.join(projectDir, 'native-bin', 'whisper-server');
  assert.equal(fs.readFileSync(installed, 'utf8'), contents.toString());
  assert.equal(sha256(fs.readFileSync(installed)), runtime.binarySha256);
  if (process.platform !== 'win32') {
    assert.ok((fs.statSync(installed).mode & 0o111) !== 0, 'the binary is executable');
  }

  const second = await prepareWhisperRuntime({
    projectDir,
    cacheDir: path.join(projectDir, 'cache'),
    fetchImpl: stubFetch(bytes, calls),
    runtime,
    log: (line) => logs.push(line),
  });
  assert.equal(second.status, 'up-to-date');
  assert.equal(calls.length, 1, 'the second run does not download again');
  assert.equal(logs.length, 2);
});

test('a tampered binary is repaired from the verified cache', async () => {
  const contents = Buffer.from('fixture server bytes');
  const { bytes } = makeTarGz({ binaryPath: 'whisper-server', contents });
  const projectDir = temporaryDir();
  const runtime = runtimeForFixture({ bytes });
  const cacheDir = path.join(projectDir, 'cache');
  await prepareWhisperRuntime({ projectDir, cacheDir, fetchImpl: stubFetch(bytes), runtime, log: () => {} });

  fs.writeFileSync(path.join(projectDir, 'native-bin', 'whisper-server'), 'tampered');
  const calls = [];
  const result = await prepareWhisperRuntime({ projectDir, cacheDir, fetchImpl: stubFetch(bytes, calls), runtime, log: () => {} });
  assert.equal(result.status, 'installed');
  assert.equal(calls.length, 0, 'the cached archive still matches the pin, so nothing is downloaded again');
  assert.equal(fs.readFileSync(path.join(projectDir, 'native-bin', 'whisper-server'), 'utf8'), contents.toString());
});

test('the skip env var opts out before any download happens', async () => {
  const projectDir = temporaryDir();
  const logs = [];
  const fetchImpl = async () => {
    throw new Error('fetch must not be called when the runtime is skipped');
  };
  const previous = process.env.VOLYX_LENS_SKIP_WHISPER_RUNTIME;
  process.env.VOLYX_LENS_SKIP_WHISPER_RUNTIME = '1';
  try {
    const result = await prepareWhisperRuntime({ platform: 'linux', arch: 'x64', projectDir, fetchImpl, log: (line) => logs.push(line) });
    assert.equal(result.status, 'skipped');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /VOLYX_LENS_SKIP_WHISPER_RUNTIME/);
  } finally {
    if (previous === undefined) delete process.env.VOLYX_LENS_SKIP_WHISPER_RUNTIME;
    else process.env.VOLYX_LENS_SKIP_WHISPER_RUNTIME = previous;
  }
  assert.equal(fs.existsSync(path.join(projectDir, 'native-bin', 'whisper-server')), false);
});

test('an unsupported target logs one line, removes a stale runtime, and keeps the native helpers', async () => {
  const projectDir = temporaryDir();
  fs.mkdirSync(path.join(projectDir, 'native-bin'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'native-bin', 'whisper-server'), 'stale linux binary');
  fs.writeFileSync(path.join(projectDir, 'native-bin', 'libwhisper.so.1'), 'stale linux library');
  fs.writeFileSync(path.join(projectDir, 'native-bin', 'volyx-lens-vision-ocr'), 'mac helper');
  const logs = [];
  const result = await prepareWhisperRuntime({
    platform: 'darwin',
    arch: 'arm64',
    projectDir,
    fetchImpl: async () => { throw new Error('fetch must not be called for darwin'); },
    log: (line) => logs.push(line),
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /darwin-arm64/);
  assert.deepEqual(result.removed.sort(), ['libwhisper.so.1', 'whisper-server'], 'a macOS package cannot inherit a Linux binary');
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'native-bin')), ['volyx-lens-vision-ocr'], 'the Vision helper is untouched');
});

test('an archive that lacks the pinned binary fails closed', async () => {
  const { bytes } = makeTarGz({ binaryPath: 'whisper-server', contents: 'fixture server bytes' });
  const projectDir = temporaryDir();
  const runtime = { ...runtimeForFixture({ bytes }), binary: 'fixture/no-such-server' };
  await assert.rejects(
    prepareWhisperRuntime({ projectDir, cacheDir: path.join(projectDir, 'cache'), fetchImpl: stubFetch(bytes), runtime, log: () => {} }),
    /does not contain/,
  );
  assert.equal(fs.existsSync(path.join(projectDir, 'native-bin', 'whisper-server')), false);
});

test('archive helpers reject unknown formats and paths that escape the extraction directory', () => {
  assert.throws(() => extractionCommands({ archive: 'tar.xz', archivePath: 'a', destination: 'b' }), /Unsupported/);
  const commands = extractionCommands({ archive: 'zip', archivePath: 'a.zip', destination: 'b', platform: 'win32' });
  assert.deepEqual(commands.map((command) => command.command), ['tar', 'unzip'], 'Windows prefers its built-in bsdtar');
  assert.throws(() => resolveInsideArchive('/tmp/extracted', '../escape'), /unsafe/);
  assert.equal(resolveInsideArchive("/tmp/extracted", "fixture/server"), path.resolve("/tmp/extracted/fixture/server"));
});

function packagedTree({ binaryContents, libraryContents = null }) {
  const distDir = temporaryDir('volyx-whisper-dist-');
  const nativeDir = path.join(distDir, 'linux-unpacked', 'resources', 'native');
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, 'whisper-server'), binaryContents, { mode: 0o755 });
  const libraries = [];
  if (libraryContents !== null) {
    fs.writeFileSync(path.join(nativeDir, 'libwhisper.so.1'), libraryContents, { mode: 0o755 });
    libraries.push({ path: 'fixture/libwhisper.so.1', name: 'libwhisper.so.1', sha256: sha256(libraryContents) });
  }
  return { distDir, nativeDir, libraries };
}

test('a packaged binary is accepted only when it matches the pinned hash and ships its libraries', () => {
  const binaryContents = Buffer.from('packaged server');
  const libraryContents = Buffer.from('packaged library');
  const { distDir, libraries } = packagedTree({ binaryContents, libraryContents });
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    release: 'v0.0.0-test',
    tag: 'btest',
    binaryName: 'whisper-server',
    binarySha256: sha256(binaryContents),
    libraries,
  };

  const verified = verifyPackagedWhisper({ distDir, platform: 'linux', arch: 'x64', runtime });
  assert.equal(verified.supported, true);
  assert.equal(verified.libraries, 1);

  const nativeDir = path.join(distDir, 'linux-unpacked', 'resources', 'native');
  fs.rmSync(path.join(nativeDir, 'libwhisper.so.1'), { force: true });
  assert.throws(
    () => verifyPackagedWhisper({ distDir, platform: 'linux', arch: 'x64', runtime }),
    /missing libwhisper\.so\.1/,
    'a server without its shared libraries cannot start',
  );

  fs.writeFileSync(path.join(nativeDir, 'whisper-server'), 'not the pinned binary');
  assert.throws(
    () => verifyPackagedWhisper({ distDir, platform: 'linux', arch: 'x64', runtime }),
    /does not match the pinned/,
  );
});

test('a missing packaged binary fails instead of passing silently', () => {
  const distDir = temporaryDir('volyx-whisper-dist-');
  fs.mkdirSync(path.join(distDir, 'linux-unpacked'), { recursive: true });
  const runtime = { platform: 'linux', arch: 'x64', binaryName: 'whisper-server', binarySha256: '0'.repeat(64), libraries: [] };
  assert.throws(() => verifyPackagedWhisper({ distDir, platform: 'linux', arch: 'x64', runtime }), /does not contain whisper-server/);
});

test('the verifier ignores a same-named file outside Resources/native', () => {
  const distDir = temporaryDir('volyx-whisper-dist-');
  fs.mkdirSync(path.join(distDir, 'linux-unpacked'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'linux-unpacked', 'whisper-server'), 'decoy');
  assert.equal(findPackagedBinary(distDir, 'whisper-server'), null);
});

test('the verifier skips targets whisper.cpp publishes no server for', () => {
  const result = verifyPackagedWhisper({ distDir: path.join(root, 'dist'), platform: 'darwin', arch: 'arm64' });
  assert.equal(result.supported, false);
  assert.equal(result.target, 'darwin-arm64');
  assert.throws(() => parseArgs(['--unknown=1']), /Unknown argument/);
  assert.deepEqual(parseArgs(['--arch=arm64', '--platform=linux', '--dist=out']), { arch: 'arm64', platform: 'linux', dist: 'out' });
});

test('beforePack chains the Vision helper build and the whisper runtime provisioning', async () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.build.beforePack, 'scripts/before-pack.js', 'electron-builder runs the chained hook');

  const { beforePack } = require('../scripts/before-pack');
  const projectDir = temporaryDir();
  const previous = process.env.VOLYX_LENS_SKIP_WHISPER_RUNTIME;
  const originalLog = console.log;
  process.env.VOLYX_LENS_SKIP_WHISPER_RUNTIME = '1';
  console.log = () => {};
  try {
    // electronPlatformName is linux so the macOS-only Swift build returns early
    // on every host; the skip env keeps this test off the network.
    const result = await beforePack({ electronPlatformName: 'linux', arch: 1, appDir: projectDir });
    assert.equal(result.status, 'skipped');
    assert.ok(fs.existsSync(path.join(projectDir, 'native-bin')), 'the Vision build step still created native-bin');
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env.VOLYX_LENS_SKIP_WHISPER_RUNTIME;
    else process.env.VOLYX_LENS_SKIP_WHISPER_RUNTIME = previous;
  }
});

test('Windows extraction names the archive relatively so a drive letter is not a host', () => {
  // bsdtar reads D:\path as host "D" and fails with "Cannot connect to D"; it has
  // no --force-local (GNU tar does), so tar runs from the archive's directory.
  const win = extractionCommands({ archive: 'zip', archivePath: '/tmp/a/x.zip', destination: '/tmp/a/out', platform: 'win32' });
  assert.equal(win[0].args[1], 'x.zip', 'the operand is the bare file name');
  assert.equal(win[0].cwd, '/tmp/a', 'tar runs inside the archive directory');
  const posix = extractionCommands({ archive: 'tar.gz', archivePath: '/tmp/x.tar.gz', destination: '/tmp/out', platform: 'linux' });
  assert.equal(posix[0].args[1], '/tmp/x.tar.gz', 'POSIX keeps the absolute path');
  assert.equal(posix[0].cwd, undefined);
});

test('a zip archive is unpacked in-process, with no tar or unzip on PATH', async () => {
  // The Windows release job runs under Git Bash, where tar is GNU tar and cannot
  // read zip; the test job resolves Windows bsdtar, which misreads drive letters.
  // Extracting in-process removes both failure modes.
  const JSZip = require('jszip');
  const { extractZipInProcess } = require('../scripts/prepare-whisper-runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-zip-'));
  const zip = new JSZip();
  zip.file('Release/whisper-server.exe', 'binary-contents');
  zip.file('Release/whisper.dll', 'dll-contents');
  fs.writeFileSync(path.join(dir, 'runtime.zip'), await zip.generateAsync({ type: 'nodebuffer' }));
  const destination = path.join(dir, 'out');
  fs.mkdirSync(destination);

  await extractZipInProcess({ archivePath: path.join(dir, 'runtime.zip'), destination });

  assert.equal(fs.readFileSync(path.join(destination, 'Release/whisper-server.exe'), 'utf8'), 'binary-contents');
  assert.equal(fs.readFileSync(path.join(destination, 'Release/whisper.dll'), 'utf8'), 'dll-contents');
});
