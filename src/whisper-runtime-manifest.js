'use strict';

// Prebuilt whisper.cpp server binaries for the platforms upstream publishes.
//
// whisper.cpp cuts its stable tags (v1.9.5, v1.9.4, ...) without assets: the
// prebuilt archives are attached to the nightly tag built from the same commit
// (b5454 is the v1.9.5 nightly). Pinning that nightly tag is therefore the only
// way to ship an official binary, so the release and the tag that hosts the files
// are both recorded. The archive, every runtime library and the server itself are
// pinned by SHA-256 because packaging downloads these bytes and the app then
// executes them on a user's machine.
//
// whisper.cpp publishes no whisper-server for macOS (the macOS asset is an
// XCFramework, a library that cannot serve HTTP), so darwin is deliberately
// absent from the manifest instead of shipping something that cannot start.

const RELEASE_VERSION = 'v1.9.5';
const RELEASE_TAG = 'b5454';
const RELEASE_BASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE_TAG}`;

// A file the server loads at run time. `name` is the name it has to carry next to
// the executable: the Linux archives ship versioned names (libwhisper.so.1.9.5)
// while the dynamic loader asks for the SONAME (libwhisper.so.1).
function runtimeLibrary(path, name, sha256) {
  return Object.freeze({ path, name, sha256 });
}

// whisper-server links against whisper.dll and the ggml DLLs. ggml discovers the
// per-CPU backend DLLs in its own directory, so they ship too; without them the
// server exits before it can load a model.
const WINDOWS_X64_LIBRARIES = Object.freeze([
  runtimeLibrary('Release/whisper.dll', 'whisper.dll', '034396d75bb5720c1851674ff64a96192b58f6927b68d334ebd254ce6cad9674'),
  runtimeLibrary('Release/ggml.dll', 'ggml.dll', '31fe18616d872af9b6134b47a6dff8072ae4ecbe5df0273f4f8dc36766c9db8e'),
  runtimeLibrary('Release/ggml-base.dll', 'ggml-base.dll', 'bede0d6b2d387236ecd2b5dd676d51c8984b5b6e0ae461a12174e9c01345c5f0'),
  runtimeLibrary('Release/ggml-cpu-alderlake.dll', 'ggml-cpu-alderlake.dll', 'd8f5c56ea490394eeae8b271650f2647aecd039a542d6df9e0140726e62a4603'),
  runtimeLibrary('Release/ggml-cpu-cannonlake.dll', 'ggml-cpu-cannonlake.dll', '74127b40abd4f595d9db6af0fa313a02e18ff42fc228bfa05281e7c788dd4507'),
  runtimeLibrary('Release/ggml-cpu-cascadelake.dll', 'ggml-cpu-cascadelake.dll', '4b11c427b844eeac87529af9a8d94b35aad2024666beb2a35e59fe3077e4b81e'),
  runtimeLibrary('Release/ggml-cpu-haswell.dll', 'ggml-cpu-haswell.dll', '1306b1014c8118d27234d8ddc0e66ced1f8c8476bf85071595fd182ea9b7263b'),
  runtimeLibrary('Release/ggml-cpu-icelake.dll', 'ggml-cpu-icelake.dll', '2b4dc4c66e7d8fe2807283816e9cf3b7f7d0556f59df34069871e37eab8aed40'),
  runtimeLibrary('Release/ggml-cpu-sandybridge.dll', 'ggml-cpu-sandybridge.dll', '04edbdebc01a1d421062a960881a4f34d520d99693999518243f332406444c6e'),
  runtimeLibrary('Release/ggml-cpu-skylakex.dll', 'ggml-cpu-skylakex.dll', '1774714cf93621406ff35344b54715619a83242ae3e331e44d98a3b35ce801be'),
  runtimeLibrary('Release/ggml-cpu-sse42.dll', 'ggml-cpu-sse42.dll', 'f060318772c4c2dbac312bbfff6ea700b85dbc502bb38585a7186d06d549301a'),
  runtimeLibrary('Release/ggml-cpu-x64.dll', 'ggml-cpu-x64.dll', '4b4b05caba40d4309b5d710ef74c59ba190516b8489f27bdb1ba11ae33c6e9d3'),
]);

const LINUX_X64_LIBRARIES = Object.freeze([
  runtimeLibrary('whisper-bin-ubuntu-x64/libwhisper.so.1.9.5', 'libwhisper.so.1', '1517f17d5188f7ef70cbb66a2b8ce258c510d20c25018d18e2801351de13cd55'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml.so.0.26.0', 'libggml.so.0', '25406a47ddc7a6b45adb4995ad5efbc6a7ef6efbc43e64a506d978d11dd6fec8'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-base.so.0.26.0', 'libggml-base.so.0', '8cd57970d5ba71529442758c0b42cb820ed319e03be0691aead74ef298d3f51f'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-alderlake.so', 'libggml-cpu-alderlake.so', 'd33aa9c10d716534dff77655da446f09516ee4583b695e8cc1aa447e57848dac'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-cannonlake.so', 'libggml-cpu-cannonlake.so', '0cb6e59a34c9798a512398e820942ee18ce99c1e0b308ec593e78655759eaafe'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-cascadelake.so', 'libggml-cpu-cascadelake.so', 'a0286798b10092eabaf5f81ce9ae664aa78d3c609ed2138fa8a7ca22da73ef7d'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-cooperlake.so', 'libggml-cpu-cooperlake.so', '4169f4b9c975e46ddc386b695f64fb3a38a3dacd40bbb15465a2a5dbcabb9a1f'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-haswell.so', 'libggml-cpu-haswell.so', 'a63377026e388671d7925e729fced52d9dd85d1bca780dce97bc2c74817053d4'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-icelake.so', 'libggml-cpu-icelake.so', '3f28f5a44dd3640cf179d4f678ea9bdacc536ad69b6b5fb5efd155b6b91c49c8'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-ivybridge.so', 'libggml-cpu-ivybridge.so', '8b22efecdde26d41d3d864f2d5f6e29c31e0951d6453465d1f4fbda50b9eaa4b'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-piledriver.so', 'libggml-cpu-piledriver.so', 'e04b72d641d4ae129c05a2ca167dae4843eb0ecae5d40a31a5d98ae480641b11'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-sandybridge.so', 'libggml-cpu-sandybridge.so', '806218b034614ad31dbe4fbae48bcc0282c966bbe9f0085380d1c49b6b0f7d0b'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-sapphirerapids.so', 'libggml-cpu-sapphirerapids.so', 'd190abfe2ad900b24da89c883f633dc621f69ba12b2f5664659826374c1f4cfb'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-skylakex.so', 'libggml-cpu-skylakex.so', '66d8e2a22ef39225eb2d80e3a1dd9c8a7dd2be41966760c27f22e79623611dd5'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-sse42.so', 'libggml-cpu-sse42.so', '58e6f62fa6bc2732c5a8b6323377ae62ba6cc1ebad9dfd298b6548819bd94375'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-x64.so', 'libggml-cpu-x64.so', 'c19a80e868a34bdb197e2901c8f785a77640d6e56055134514b5fa2807171af5'),
  runtimeLibrary('whisper-bin-ubuntu-x64/libggml-cpu-zen4.so', 'libggml-cpu-zen4.so', '42bb25dff93816eb12327a1b82c04ae436dd17eebf30da556143ec9acffd9582'),
]);

const LINUX_ARM64_LIBRARIES = Object.freeze([
  runtimeLibrary('whisper-bin-ubuntu-arm64/libwhisper.so.1.9.5', 'libwhisper.so.1', '1b126affbb535ec35c5fd83bbe17d465731a4b9d8ae00e2d3215ffd2a4f7e725'),
  runtimeLibrary('whisper-bin-ubuntu-arm64/libggml.so.0.26.0', 'libggml.so.0', '2c8795ca216c624f2be8c2b4e8c5262f9ac138a5a99d912308460f9c63bedc61'),
  runtimeLibrary('whisper-bin-ubuntu-arm64/libggml-base.so.0.26.0', 'libggml-base.so.0', '55ab0c640984646608f00f7cd382ff3780363b4aaaad7c6b65be059571a2eefd'),
  runtimeLibrary('whisper-bin-ubuntu-arm64/libggml-cpu.so', 'libggml-cpu.so', 'e8089bef17a3c3b4917c8693e22f672e0073356641c37fd15d8f9029a57b3276'),
]);

const MANIFEST = Object.freeze({
  'win32-x64': Object.freeze({
    platform: 'win32',
    arch: 'x64',
    release: RELEASE_VERSION,
    tag: RELEASE_TAG,
    asset: 'whisper-bin-x64.zip',
    assetUrl: `${RELEASE_BASE_URL}/whisper-bin-x64.zip`,
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    archive: 'zip',
    binary: 'Release/whisper-server.exe',
    binaryName: 'whisper-server.exe',
    binarySha256: 'a97456e747f28e7bb09c1dac35f40d94404c5ecffa74aaaaa7a3753ea6543121',
    libraries: WINDOWS_X64_LIBRARIES,
  }),
  'linux-x64': Object.freeze({
    platform: 'linux',
    arch: 'x64',
    release: RELEASE_VERSION,
    tag: RELEASE_TAG,
    asset: 'whisper-bin-ubuntu-x64.tar.gz',
    assetUrl: `${RELEASE_BASE_URL}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c',
    archive: 'tar.gz',
    binary: 'whisper-bin-ubuntu-x64/whisper-server',
    binaryName: 'whisper-server',
    binarySha256: '864cae691ad3eea424152d4d86f17bc22d6d39b0d0c5a91577038178eb8a1659',
    libraries: LINUX_X64_LIBRARIES,
  }),
  'linux-arm64': Object.freeze({
    platform: 'linux',
    arch: 'arm64',
    release: RELEASE_VERSION,
    tag: RELEASE_TAG,
    asset: 'whisper-bin-ubuntu-arm64.tar.gz',
    assetUrl: `${RELEASE_BASE_URL}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149',
    archive: 'tar.gz',
    binary: 'whisper-bin-ubuntu-arm64/whisper-server',
    binaryName: 'whisper-server',
    binarySha256: '1830e2943b1c8ae0fa4def8cc7d52a80d844670f6606bd53a8d77aa5c5d31e78',
    libraries: LINUX_ARM64_LIBRARIES,
  }),
});

// electron-builder reports the target architecture as its Arch enum in beforePack
// (1 = x64, 3 = arm64) and as a string elsewhere; both spellings mean one target.
const ARCH_ALIASES = new Map([
  ['x64', 'x64'],
  ['x86_64', 'x64'],
  ['amd64', 'x64'],
  [1, 'x64'],
  ['arm64', 'arm64'],
  ['aarch64', 'arm64'],
  [3, 'arm64'],
]);

function normalizeArch(arch) {
  if (arch === undefined || arch === null) return null;
  const key = typeof arch === 'string' ? arch.trim().toLowerCase() : arch;
  return ARCH_ALIASES.get(key) || null;
}

function platformKey({ platform, arch } = {}) {
  const normalizedArch = normalizeArch(arch);
  if (!platform || !normalizedArch) return null;
  return `${String(platform).trim().toLowerCase()}-${normalizedArch}`;
}

// Returns the pinned runtime for a target, or null when whisper.cpp publishes no
// prebuilt server for it. A null result is a supported outcome (macOS), not an
// error: the caller must leave offline transcription unavailable instead of
// promising an engine that cannot start.
function runtimeFor({ platform, arch } = {}) {
  const key = platformKey({ platform, arch });
  return key ? MANIFEST[key] || null : null;
}

module.exports = {
  RELEASE_VERSION,
  RELEASE_TAG,
  MANIFEST,
  ARCH_ALIASES,
  normalizeArch,
  platformKey,
  runtimeFor,
};
