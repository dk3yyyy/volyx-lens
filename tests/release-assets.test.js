'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifyReleaseAssets } = require('../src/release-assets');
const { channelFileFor } = require('../src/update-metadata');
const { releaseChannel } = require('../src/update-manager');

const WIN_EXE = 'volyx-lens-0.7.6-win-x64.exe';
const WIN_SHA = `${WIN_EXE}.sha256`;
const LINUX_X64_APPIMAGE = 'volyx-lens-0.7.6-linux-x86_64.AppImage';
const LINUX_ARM64_APPIMAGE = 'volyx-lens-0.7.6-linux-arm64.AppImage';
const MAC_ARM64_ZIP = 'volyx-lens-0.7.6-mac-arm64.zip';
const MAC_ARM64_DMG = 'volyx-lens-0.7.6-mac-arm64.dmg';
const LINUX_X64_META = 'latest-x64-linux.yml';
const LINUX_ARM64_META = 'latest-arm64-linux-arm64.yml';
const MAC_ARM64_META = 'latest-arm64-mac.yml';

function check(input) {
  return verifyReleaseAssets(input);
}

function expectOk(input) {
  const result = check(input);
  assert.deepEqual(result, { ok: true, problems: [] });
}

function expectProblems(input, patterns) {
  const result = check(input);
  assert.equal(result.ok, false, 'the set should be rejected');
  assert.ok(result.problems.length > 0, 'problems are human-readable strings');
  for (const pattern of patterns) {
    assert.ok(
      result.problems.some((problem) => typeof problem === 'string' && pattern.test(problem)),
      `expected a problem matching ${pattern}; got ${JSON.stringify(result.problems)}`,
    );
  }
}

// The two Linux channel names the client actually requests. They are derived
// from the shared rule, so this test fails if the workflow naming and the
// updater ever disagree again.
test('Linux metadata names come from channelFileFor, not a hand-written template', () => {
  assert.equal(
    channelFileFor({ platform: 'linux', arch: 'x64', channel: releaseChannel('linux', 'x64') }),
    LINUX_X64_META,
  );
  assert.equal(
    channelFileFor({ platform: 'linux', arch: 'arm64', channel: releaseChannel('linux', 'arm64') }),
    LINUX_ARM64_META,
  );
});

test('an unsigned Windows set publishes no latest.yml and one checksummed installer', () => {
  expectOk({ platform: 'win32', files: [WIN_EXE, WIN_SHA, 'volyx-lens-windows.cdx.json'] });
});

test('an unsigned Windows set is rejected when latest.yml is published', () => {
  expectProblems(
    { platform: 'win32', files: [WIN_EXE, WIN_SHA, 'latest.yml'] },
    [/latest\.yml/, /unsigned/i],
  );
});

test('a signed Windows set must keep latest.yml', () => {
  expectOk({ platform: 'win32', signed: true, files: [WIN_EXE, WIN_SHA, 'latest.yml'] });
  expectProblems(
    { platform: 'win32', signed: true, files: [WIN_EXE, WIN_SHA] },
    [/missing latest\.yml/],
  );
});

test('an installer without its checksum is rejected', () => {
  expectProblems({ platform: 'win32', files: [WIN_EXE] }, [/no checksum/, /\.exe\.sha256/]);
});

test('the checksum file is not mistaken for a second installer', () => {
  expectOk({ platform: 'win32', files: [WIN_EXE, WIN_SHA] });
  expectOk({ platform: 'linux', files: [LINUX_X64_APPIMAGE, `${LINUX_X64_APPIMAGE}.sha256`, LINUX_X64_META] });
});

test('duplicate Windows installers for the same platform/arch are rejected as a re-run', () => {
  const older = 'volyx-lens-0.7.5-win-x64.exe';
  const result = check({ platform: 'win32', files: [WIN_EXE, WIN_SHA, older, `${older}.sha256`] });
  assert.equal(result.ok, false);
  const message = result.problems.join('\n');
  assert.match(message, /exactly one \*\.exe/);
  assert.match(message, /volyx-lens-0\.7\.6-win-x64\.exe/);
  assert.match(message, /volyx-lens-0\.7\.5-win-x64\.exe/);
});

test('the x64 Linux set uses latest-x64-linux.yml', () => {
  expectOk({
    platform: 'linux',
    files: [LINUX_X64_APPIMAGE, `${LINUX_X64_APPIMAGE}.sha256`, LINUX_X64_META],
  });
});

test('the arm64 Linux set uses latest-arm64-linux-arm64.yml', () => {
  expectOk({
    platform: 'linux',
    files: [LINUX_ARM64_APPIMAGE, `${LINUX_ARM64_APPIMAGE}.sha256`, LINUX_ARM64_META],
  });
});

test('the old arm64 Linux name is rejected and the requested name is reported', () => {
  expectProblems(
    {
      platform: 'linux',
      arch: 'arm64',
      files: [LINUX_ARM64_APPIMAGE, `${LINUX_ARM64_APPIMAGE}.sha256`, 'latest-arm64-linux.yml'],
    },
    [
      /latest-arm64-linux\.yml is not the name clients request/,
      /expected latest-arm64-linux-arm64\.yml/,
    ],
  );
  // The x86_64 artifact token is not part of the metadata name the client asks
  // for: x64 requests latest-x64-linux.yml even though electron-builder emits
  // AppImage names with -x86_64.
  expectProblems(
    {
      platform: 'linux',
      arch: 'x64',
      files: [LINUX_X64_APPIMAGE, `${LINUX_X64_APPIMAGE}.sha256`, 'latest-x64-linux-x86_64.yml'],
    },
    [/expected latest-x64-linux\.yml/],
  );
});

test('two channel files for the same Linux architecture are rejected', () => {
  expectProblems(
    {
      platform: 'linux',
      arch: 'x64',
      files: [LINUX_X64_APPIMAGE, `${LINUX_X64_APPIMAGE}.sha256`, LINUX_X64_META, 'latest-x64-linux-x86_64.yml'],
    },
    [/expected exactly one channel file/, /latest-x64-linux-x86_64\.yml/],
  );
});

test('Linux requires exactly one AppImage and its checksum', () => {
  expectProblems(
    { platform: 'linux', arch: 'x64', files: [LINUX_X64_META] },
    [/missing a \*\.AppImage/],
  );
  expectProblems(
    { platform: 'linux', arch: 'x64', files: [LINUX_X64_APPIMAGE, LINUX_X64_META] },
    [/no checksum/],
  );
});

test('duplicate Linux AppImages for the same architecture are rejected', () => {
  const older = 'volyx-lens-0.7.5-linux-x86_64.AppImage';
  expectProblems(
    {
      platform: 'linux',
      arch: 'x64',
      files: [LINUX_X64_APPIMAGE, `${LINUX_X64_APPIMAGE}.sha256`, older, `${older}.sha256`, LINUX_X64_META],
    },
    [/duplicate AppImages/, /0\.7\.6/, /0\.7\.5/],
  );
});

test('a merged Linux publish directory passes when the check is scoped by --arch', () => {
  const merged = [
    LINUX_X64_APPIMAGE,
    `${LINUX_X64_APPIMAGE}.sha256`,
    LINUX_X64_META,
    LINUX_ARM64_APPIMAGE,
    `${LINUX_ARM64_APPIMAGE}.sha256`,
    LINUX_ARM64_META,
    'volyx-lens-linux-x64.cdx.json',
    'volyx-lens-linux-arm64.cdx.json',
  ];
  expectOk({ platform: 'linux', arch: 'x64', files: merged });
  expectOk({ platform: 'linux', arch: 'arm64', files: merged });
});

test('Linux derives the architecture from the published AppImage when --arch is omitted', () => {
  expectOk({
    platform: 'linux',
    files: [LINUX_ARM64_APPIMAGE, `${LINUX_ARM64_APPIMAGE}.sha256`, LINUX_ARM64_META],
  });
});

test('an unsigned macOS set publishes no latest*.yml', () => {
  expectProblems(
    { platform: 'darwin', signed: false, files: [MAC_ARM64_ZIP, MAC_ARM64_DMG, MAC_ARM64_META] },
    [/unsigned macOS build/, /latest-arm64-mac\.yml/],
  );
  expectProblems(
    { platform: 'darwin', signed: false, files: [MAC_ARM64_ZIP, 'latest.yml'] },
    [/latest\.yml/],
  );
});

test('a signed macOS set publishes latest-<arch>-mac.yml with the signed DMGs', () => {
  expectOk({
    platform: 'darwin',
    signed: true,
    files: [
      MAC_ARM64_ZIP,
      `${MAC_ARM64_ZIP}.sha256`,
      MAC_ARM64_DMG,
      `${MAC_ARM64_DMG}.sha256`,
      MAC_ARM64_META,
      'volyx-lens-arm64.cdx.json',
    ],
  });
});

test('a signed macOS set without its updater metadata is rejected', () => {
  expectProblems(
    { platform: 'darwin', signed: true, arch: 'arm64', files: [MAC_ARM64_ZIP, MAC_ARM64_DMG] },
    [/missing latest-arm64-mac\.yml/],
  );
});

test('a merged macOS publish directory passes when the check is scoped by --arch', () => {
  const merged = [
    MAC_ARM64_ZIP,
    MAC_ARM64_DMG,
    MAC_ARM64_META,
    'volyx-lens-0.7.6-mac-x64.zip',
    'volyx-lens-0.7.6-mac-x64.dmg',
    'latest-x64-mac.yml',
  ];
  expectOk({ platform: 'darwin', signed: true, arch: 'arm64', files: merged });
  expectOk({ platform: 'darwin', signed: true, arch: 'x64', files: merged });
});

test('duplicate macOS archives for the same architecture are rejected', () => {
  const older = 'volyx-lens-0.7.5-mac-arm64.zip';
  expectProblems(
    { platform: 'darwin', signed: true, arch: 'arm64', files: [MAC_ARM64_ZIP, older, MAC_ARM64_META] },
    [/duplicate \.zip archives/, /0\.7\.6/, /0\.7\.5/],
  );
});

test('an intentionally metadata-free Linux build passes with metadata: none', () => {
  expectOk({
    platform: 'linux',
    arch: 'x64',
    metadata: 'none',
    files: [LINUX_X64_APPIMAGE, `${LINUX_X64_APPIMAGE}.sha256`, 'volyx-lens-linux-x64.cdx.json'],
  });
  expectProblems(
    {
      platform: 'linux',
      arch: 'x64',
      metadata: 'none',
      files: [LINUX_X64_APPIMAGE, `${LINUX_X64_APPIMAGE}.sha256`, LINUX_X64_META],
    },
    [/intentionally publishes no updater metadata/],
  );
});

test('full paths are reduced to file names', () => {
  expectOk({
    platform: 'linux',
    arch: 'x64',
    files: [
      `/tmp/dist/${LINUX_X64_APPIMAGE}`,
      `dist/${LINUX_X64_APPIMAGE}.sha256`,
      `dist\\${LINUX_X64_META}`,
    ],
  });
});

test('bad input returns problems instead of throwing', () => {
  assert.doesNotThrow(() => verifyReleaseAssets());
  assert.doesNotThrow(() => verifyReleaseAssets(null));
  expectProblems({}, [/unsupported platform/]);
  expectProblems({ platform: 'freebsd', files: [] }, [/unsupported platform/]);
  expectProblems({ platform: 'win32' }, [/files must be an array/]);
  expectProblems({ platform: 'linux', files: ['x'], arch: 'ppc64' }, [/unsupported architecture/]);
  expectProblems({ platform: 'darwin', signed: true, files: ['README.md'] }, [/cannot determine the architecture/]);
});

test('the CLI lists the directory, prints problems, and exits 1 for a bad set', () => {
  const cli = path.join(__dirname, '..', 'scripts', 'verify-release-assets.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-release-assets-'));
  try {
    fs.writeFileSync(path.join(dir, WIN_EXE), 'installer');
    fs.writeFileSync(path.join(dir, WIN_SHA), 'checksum');
    const ok = spawnSync(process.execPath, [cli, '--platform', 'win32', '--dir', dir], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /volyx-lens-0\.7\.6-win-x64\.exe/);

    fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 0.7.6');
    const bad = spawnSync(process.execPath, [cli, '--platform', 'win32', '--dir', dir], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /latest\.yml/);

    const usage = spawnSync(process.execPath, [cli, '--platform', 'win32'], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every release workflow runs the CLI before it uploads assets', () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8');
  const windows = read('release-windows.yml');
  // Signed and unsigned Windows build the same workflow, so both branches are
  // guarded; the unsigned branch is the one that must reject a stray latest.yml.
  assert.match(windows, /verify-release-assets\.js --platform win32 --dir dist --signed --arch x64/);
  assert.match(windows, /verify-release-assets\.js --platform win32 --dir dist --arch x64/);
  assert.match(read('release-linux.yml'), /verify-release-assets\.js --platform linux --dir dist --arch "\$ARCH"/);
  assert.match(read('release-macos.yml'), /verify-release-assets\.js --platform darwin --dir dist --signed --arch "\$\{\{ matrix\.arch \}\}"/);
  assert.match(read('build-windows-unsigned.yml'), /verify-release-assets\.js --platform win32 --dir dist --arch x64/);
  assert.match(read('build-linux-unsigned.yml'), /verify-release-assets\.js --platform linux --dir dist --arch[^\n]*--no-metadata/);
});

test('CI runs the unit suite on Node 20 and 22 but coverage and syntax once', () => {
  const ci = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /node: \[20, 22\]/);
  assert.match(ci, /if: matrix\.node != 20\s*\n\s*run: npm test/);
  assert.match(ci, /if: matrix\.node == 20\s*\n\s*run: npm run coverage/);
  assert.match(ci, /if: matrix\.node == 20\s*\n\s*run: npm run check:syntax/);
  // The other jobs stay on Node 20 so the matrix does not multiply the cost of
  // packaging, Windows, macOS, and the Swift toolchain.
  assert.equal((ci.match(/node-version: 20/g) || []).length, 2);
});
