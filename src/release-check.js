'use strict';

// Pure helpers for the lightweight GitHub Releases check used by unsigned
// builds. Nothing here touches the network, Electron, or package.json so the
// module can be exercised in a plain Node process.

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MAX_TAG_LENGTH = 64;

function parseRelease(tag) {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!trimmed || trimmed.length > MAX_TAG_LENGTH) return null;

  const match = VERSION_PATTERN.exec(trimmed);
  if (!match) return null;

  return {
    version: trimmed.slice(0, 1) === 'v' ? trimmed.slice(1) : trimmed,
    major: match[1],
    minor: match[2],
    patch: match[3],
    // Build metadata (the "+..." part) never participates in precedence.
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

function parseReleaseVersion(tag) {
  const parsed = parseRelease(tag);
  return parsed ? parsed.version : null;
}

// Compare numeric identifiers without going through Number, so identifiers
// longer than Number.MAX_SAFE_INTEGER still order correctly.
function compareNumericIdentifiers(a, b) {
  const left = a.replace(/^0+(?=\d)/, '');
  const right = b.replace(/^0+(?=\d)/, '');
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(a, b) {
  if (!a && !b) return 0;
  // A release without a prerelease outranks any prerelease of the same core.
  if (!a) return 1;
  if (!b) return -1;

  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    // All shared identifiers equal so far: the shorter list is lower.
    if (index >= a.length) return -1;
    if (index >= b.length) return 1;

    const left = a[index];
    const right = b[index];
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);

    if (leftNumeric && rightNumeric) {
      const result = compareNumericIdentifiers(left, right);
      if (result !== 0) return result;
    } else if (leftNumeric) {
      // Semver: numeric identifiers always sort below alphanumeric ones.
      return -1;
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      // ASCII lexical order, matching semver's identifier precedence.
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(a, b) {
  const left = parseRelease(a);
  const right = parseRelease(b);

  if (!left || !right) {
    // Unparsable values have no semver order. Identical inputs compare equal;
    // otherwise an unparsable side ranks below a parsable one.
    const same = String(a === null || a === undefined ? '' : a).trim() ===
      String(b === null || b === undefined ? '' : b).trim();
    if (same) return 0;
    if (!left && right) return -1;
    if (left && !right) return 1;
    return 0;
  }

  const core = ['major', 'minor', 'patch'];
  for (const key of core) {
    const result = compareNumericIdentifiers(left[key], right[key]);
    if (result !== 0) return result;
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

// Only ever surface a GitHub HTTPS release URL. shell.openExternal must never
// receive an arbitrary scheme or a non-GitHub redirect target.
function safeReleaseUrl(release) {
  const url = release && typeof release.html_url === 'string' ? release.html_url : null;
  return url && url.startsWith('https://github.com/') ? url : null;
}

function releaseUpdateFrom({ currentVersion, release } = {}) {
  const url = safeReleaseUrl(release);
  const version = release && typeof release.tag_name === 'string'
    ? parseReleaseVersion(release.tag_name)
    : null;
  const hasCurrentVersion = typeof currentVersion === 'string' && currentVersion.trim() !== '';

  if (!version || !hasCurrentVersion) {
    return { available: false, version: null, url };
  }

  return {
    available: compareVersions(version, currentVersion) > 0,
    version,
    url,
  };
}

module.exports = {
  parseReleaseVersion,
  compareVersions,
  releaseUpdateFrom,
};
