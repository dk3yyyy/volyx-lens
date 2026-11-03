'use strict';

// Release asset set verification.
//
// Release jobs upload with `gh release upload --clobber`, so a re-run, a retried
// job, or a partially configured build can replace a good artifact with a worse
// one while the release page still looks healthy. These rules describe the set
// each platform is allowed to publish; the workflows run them in the build job
// before anything is uploaded.
//
// The module is pure on purpose: it takes file names and returns human-readable
// problems, so the release policy is testable without building an installer and
// a bad set can never throw its way past a `set -e` shell.

const { channelFileFor } = require('./update-metadata');
const { releaseChannel } = require('./update-manager');

const PLATFORMS = ['win32', 'linux', 'darwin'];
const ARCH_ALIASES = new Map([
  ['x64', 'x64'],
  ['x86_64', 'x64'],
  ['amd64', 'x64'],
  ['arm64', 'arm64'],
  ['aarch64', 'arm64'],
]);

// electron-builder artifact names carry the OS then the arch token, for example
// volyx-lens-0.7.6-win-x64.exe or volyx-lens-0.7.6-linux-x86_64.AppImage. The
// optional "-unsigned" suffix covers the explicit unsigned macOS artifacts.
const ARTIFACT_ARCH = /-(?:win|mac|linux)-(x64|x86_64|amd64|arm64|aarch64)(?:-unsigned)?\.(?:exe|appimage|zip|dmg)$/i;
// The version sits between the product name and the OS token, so the OS token
// (not the semver pre-release grammar) terminates it: a lazy match keeps
// 0.8.0-beta.1 intact while stopping before "-win"/"-mac"/"-linux".
const VERSION = /^volyx-lens-(.+?)-(?:win|mac|linux)-(?:x64|x86_64|amd64|arm64|aarch64)(?:-unsigned)?\.(?:exe|appimage|zip|dmg)$/i;
const METADATA = /^latest(?:[^/\\]*)?\.yml$/i;
const METADATA_ARCH = /^latest-(x64|arm64)(?:-linux(?:-(?:x64|x86_64|arm64))?|-mac)?\.yml$/i;

function basename(value) {
  const text = String(value);
  const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return index === -1 ? text : text.slice(index + 1);
}

function normalizeArch(value) {
  if (typeof value !== 'string') return null;
  return ARCH_ALIASES.get(value.trim().toLowerCase()) || null;
}

// The name the updater asks for, derived from the shared rule instead of a
// hand-written template. This is the whole reason arm64 Linux updates used to
// 404: the published file was latest-arm64-linux.yml while clients requested
// latest-arm64-linux-arm64.yml.
function metadataNameFor(platform, arch) {
  return channelFileFor({ platform, arch, channel: releaseChannel(platform, arch) });
}

function isExtension(name, extension) {
  return name.toLowerCase().endsWith(extension);
}

function isMetadata(name) {
  return METADATA.test(name);
}

function archOfArtifact(name) {
  const match = ARTIFACT_ARCH.exec(name);
  return match ? normalizeArch(match[1]) : null;
}

function versionOf(name) {
  const match = VERSION.exec(name);
  return match ? match[1] : null;
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return null;
  const seen = new Set();
  const names = [];
  for (const entry of files) {
    if (typeof entry !== 'string') continue;
    const name = basename(entry).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

// Used in problem messages so a duplicate is identifiable: two installers with
// the same platform/arch but different versions are the "re-run uploaded the
// wrong version" case this check exists for.
function describe(names) {
  return names
    .map((name) => {
      const version = versionOf(name);
      return version ? `${name} (${version})` : name;
    })
    .join(', ');
}

function requireChecksum(files, artifact, label, problems) {
  const expected = `${artifact}.sha256`;
  const present = files.some((name) => name.toLowerCase() === expected.toLowerCase());
  if (!present) {
    problems.push(`${label}: ${artifact} has no checksum; publish ${expected} next to it`);
  }
}

function deriveArch(platform, files) {
  const found = new Set();
  for (const name of files) {
    if (platform === 'linux' && isExtension(name, '.appimage')) found.add(archOfArtifact(name));
    if (platform === 'darwin' && (isExtension(name, '.zip') || isExtension(name, '.dmg'))) found.add(archOfArtifact(name));
    if (platform === 'win32' && isExtension(name, '.exe')) found.add(archOfArtifact(name));
    if (isMetadata(name)) {
      const match = METADATA_ARCH.exec(name);
      if (match) found.add(normalizeArch(match[1]));
    }
  }
  found.delete(null);
  const arches = [...found];
  return { arch: arches.length === 1 ? arches[0] : null, arches };
}

function verifyWindows(files, signed, metadataMode, problems) {
  const installers = files.filter((name) => isExtension(name, '.exe'));
  if (installers.length === 0) {
    problems.push('win32: missing the installer; exactly one *.exe is published');
  } else if (installers.length > 1) {
    problems.push(`win32: expected exactly one *.exe installer, found ${installers.length}: ${describe(installers)}; a re-run must not upload a second build`);
  }
  for (const installer of installers) requireChecksum(files, installer, 'win32', problems);

  const hasLatest = files.some((name) => name.toLowerCase() === 'latest.yml');
  if (metadataMode === 'none') {
    if (hasLatest) {
      problems.push('win32: latest.yml is published, but this build intentionally publishes no updater metadata');
    }
  } else if (signed) {
    if (!hasLatest) {
      problems.push('win32 (signed): missing latest.yml; a signed installer must keep its update channel');
    }
  } else if (hasLatest) {
    problems.push('win32 (unsigned): latest.yml is published; an unsigned installer must not advertise an update channel');
  }
}

function verifyLinux(files, arch, metadataMode, problems) {
  const label = `linux/${arch}`;
  const images = files.filter((name) => isExtension(name, '.appimage') && archOfArtifact(name) === arch);
  const otherImages = files.filter((name) => isExtension(name, '.appimage') && archOfArtifact(name) !== arch);
  if (images.length === 0) {
    problems.push(otherImages.length
      ? `${label}: missing a *.AppImage for ${arch}; found ${describe(otherImages)}`
      : `${label}: missing a *.AppImage`);
  } else if (images.length > 1) {
    problems.push(`${label}: duplicate AppImages: ${describe(images)}; exactly one build is published per architecture`);
  }
  for (const image of images) requireChecksum(files, image, label, problems);

  const expected = metadataNameFor('linux', arch);
  const metadata = files.filter((name) => isMetadata(name));
  if (metadataMode === 'none') {
    for (const name of metadata) {
      problems.push(`${label}: ${name} is a channel file, but this build intentionally publishes no updater metadata`);
    }
    return;
  }

  // Only the channel files that claim this architecture participate: a merged
  // publish directory legitimately holds the other architecture's metadata, so
  // the "exactly one" rule is scoped to this arch's names.
  const tokens = arch === 'x64' ? ['x64', 'x86_64'] : ['arm64'];
  const family = metadata.filter((name) => new RegExp(`^latest-(?:${arch}-linux(?:-(?:${tokens.join('|')}))?|${arch}|linux-(?:${tokens.join('|')}))\\.yml$`, 'i').test(name));
  if (family.length === 0) {
    problems.push(`${label}: missing ${expected}, the channel file electron-updater requests`);
  } else if (family.length > 1) {
    problems.push(`${label}: expected exactly one channel file, found ${family.join(', ')}; clients request ${expected}`);
  } else if (family[0].toLowerCase() !== expected.toLowerCase()) {
    problems.push(`${label}: ${family[0]} is not the name clients request; expected ${expected}`);
  }
}

function verifyDarwin(files, arch, signed, metadataMode, problems) {
  const label = `darwin/${arch}`;
  const metadata = files.filter((name) => isMetadata(name));
  if (metadataMode === 'none') {
    for (const name of metadata) {
      problems.push(`${label}: ${name} is a channel file, but this build intentionally publishes no updater metadata`);
    }
  } else if (!signed) {
    for (const name of metadata) {
      problems.push(`darwin (unsigned): ${name} is published; an unsigned macOS build must publish no latest*.yml`);
    }
  } else {
    const expected = metadataNameFor('darwin', arch);
    if (!metadata.some((name) => name.toLowerCase() === expected.toLowerCase())) {
      problems.push(`${label} (signed): missing ${expected}, the updater metadata electron-updater requests`);
    }
  }

  for (const extension of ['.zip', '.dmg']) {
    const archives = files.filter((name) => isExtension(name, extension) && archOfArtifact(name) === arch);
    if (archives.length > 1) {
      problems.push(`${label}: duplicate ${extension} archives: ${describe(archives)}; exactly one build is published per architecture`);
    }
  }
}

/**
 * Check the set of files a release job is about to publish.
 *
 * @param {object} options
 * @param {'win32'|'linux'|'darwin'} options.platform
 * @param {string[]} options.files published file names (paths are reduced to basenames)
 * @param {boolean} [options.signed] whether this build carries a signing certificate
 * @param {string} [options.arch] x64 or arm64; derived from the file names when omitted
 * @param {'required'|'none'} [options.metadata] "none" only for builds that intentionally publish no updater metadata
 * @returns {{ ok: boolean, problems: string[] }}
 */
function verifyReleaseAssets(input) {
  const options = input && typeof input === 'object' ? input : {};
  const problems = [];
  if (typeof options.platform !== 'string' || !PLATFORMS.includes(options.platform)) {
    problems.push(`unsupported platform "${String(options.platform)}"; expected one of ${PLATFORMS.join(', ')}`);
    return { ok: false, problems };
  }
  const files = normalizeFiles(options.files);
  if (!files) {
    problems.push('files must be an array of published file names');
    return { ok: false, problems };
  }

  const platform = options.platform;
  const signed = options.signed === true;
  const metadataMode = options.metadata === 'none' ? 'none' : 'required';

  let arch = null;
  const requested = options.arch === undefined || options.arch === null || options.arch === '' ? null : options.arch;
  if (requested !== null) {
    arch = normalizeArch(requested);
    if (!arch) {
      problems.push(`unsupported architecture "${String(requested)}"; expected x64 or arm64`);
      return { ok: false, problems };
    }
  } else {
    const derived = deriveArch(platform, files);
    arch = derived.arch;
    if (!arch && (platform === 'linux' || platform === 'darwin')) {
      problems.push(`${platform}: cannot determine the architecture from the published files${derived.arches.length ? ` (found ${derived.arches.join(', ')})` : ''}; pass --arch x64 or --arch arm64`);
      return { ok: false, problems };
    }
  }

  if (platform === 'win32') verifyWindows(files, signed, metadataMode, problems);
  else if (platform === 'linux') verifyLinux(files, arch, metadataMode, problems);
  else verifyDarwin(files, arch, signed, metadataMode, problems);

  return { ok: problems.length === 0, problems };
}

module.exports = { verifyReleaseAssets };
