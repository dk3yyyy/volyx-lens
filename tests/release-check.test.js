'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseReleaseVersion,
  compareVersions,
  releaseUpdateFrom,
} = require('../src/release-check');

const GITHUB_RELEASE = 'https://github.com/dk3yyyy/volyx-lens/releases/tag/v0.7.6';

test('parseReleaseVersion accepts v-prefixed and bare semver tags', () => {
  assert.equal(parseReleaseVersion('v0.7.6'), '0.7.6');
  assert.equal(parseReleaseVersion('0.7.6'), '0.7.6');
  assert.equal(parseReleaseVersion('  v0.7.6  '), '0.7.6');
  assert.equal(parseReleaseVersion('v1.2.3-beta.1'), '1.2.3-beta.1');
  assert.equal(parseReleaseVersion('1.2.3'), '1.2.3');
});

test('parseReleaseVersion rejects empty, oversized and non-version tags', () => {
  assert.equal(parseReleaseVersion(''), null);
  assert.equal(parseReleaseVersion('   '), null);
  assert.equal(parseReleaseVersion('v'), null);
  assert.equal(parseReleaseVersion('latest'), null);
  assert.equal(parseReleaseVersion('v1.2'), null);
  assert.equal(parseReleaseVersion('v1.2.3.4'), null);
  assert.equal(parseReleaseVersion('release-v1.2.3'), null);
  assert.equal(parseReleaseVersion('v1.2.3-'), null);
  assert.equal(parseReleaseVersion('v1.2.3-beta..1'), null);
  assert.equal(parseReleaseVersion(null), null);
  assert.equal(parseReleaseVersion(123), null);
  assert.equal(parseReleaseVersion(`1.2.3-${'a'.repeat(64)}`), null);
});

test('v-prefixed and bare tags of the same version compare equal', () => {
  assert.equal(compareVersions('v0.7.6', '0.7.6'), 0);
  assert.equal(compareVersions('0.7.6', 'v0.7.6'), 0);
  assert.equal(compareVersions('  v1.2.3  ', '1.2.3'), 0);
});

test('core components are compared numerically', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.9.9', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('a prerelease sorts below its release, and prereleases order per semver', () => {
  assert.equal(compareVersions('0.7.6-beta.1', '0.7.6'), -1);
  assert.equal(compareVersions('0.7.6', '0.7.6-beta.1'), 1);
  assert.equal(compareVersions('0.7.6-beta.2', '0.7.6-beta.1'), 1);
  assert.equal(compareVersions('0.7.6-beta.1', '0.7.6-beta.2'), -1);
  assert.equal(compareVersions('0.7.6-alpha', '0.7.6-beta'), -1);
  assert.equal(compareVersions('0.7.6-beta', '0.7.6-alpha'), 1);
  // Numeric identifiers sort below alphanumeric identifiers.
  assert.equal(compareVersions('0.7.6-1', '0.7.6-alpha'), -1);
  // A longer identifier list wins when every shared identifier is equal.
  assert.equal(compareVersions('0.7.6-beta.1', '0.7.6-beta.1.1'), -1);
  assert.equal(compareVersions('0.7.6-beta.01', '0.7.6-beta.1'), 0);
});

test('unparsable inputs compare equal only when identical and rank below parsable ones', () => {
  assert.equal(compareVersions('garbage', 'garbage'), 0);
  assert.equal(compareVersions(null, null), 0);
  assert.equal(compareVersions('garbage', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', 'garbage'), 1);
  assert.equal(compareVersions(null, 'v1.0.0'), -1);
});

test('available is true only for a strictly newer release', () => {
  const newer = releaseUpdateFrom({
    currentVersion: '0.7.5',
    release: { tag_name: 'v0.7.6', html_url: GITHUB_RELEASE },
  });
  assert.deepEqual(newer, { available: true, version: '0.7.6', url: GITHUB_RELEASE });

  const equal = releaseUpdateFrom({
    currentVersion: '0.7.6',
    release: { tag_name: 'v0.7.6', html_url: GITHUB_RELEASE },
  });
  assert.equal(equal.available, false);

  const older = releaseUpdateFrom({
    currentVersion: '0.8.0',
    release: { tag_name: 'v0.7.6', html_url: GITHUB_RELEASE },
  });
  assert.equal(older.available, false);
});

test('a prerelease of the current version is not an available update', () => {
  const checked = releaseUpdateFrom({
    currentVersion: '0.7.6',
    release: { tag_name: 'v0.7.6-beta.1', html_url: GITHUB_RELEASE },
  });
  assert.equal(checked.available, false);
});

test('a non-GitHub html_url is dropped', () => {
  const hostile = releaseUpdateFrom({
    currentVersion: '0.7.5',
    release: { tag_name: 'v0.7.6', html_url: 'https://evil.example/v0.7.6' },
  });
  assert.equal(hostile.available, true);
  assert.equal(hostile.url, null);

  const script = releaseUpdateFrom({
    currentVersion: '0.7.5',
    release: { tag_name: 'v0.7.6', html_url: 'javascript:alert(1)' },
  });
  assert.equal(script.url, null);

  const lookalike = releaseUpdateFrom({
    currentVersion: '0.7.5',
    release: { tag_name: 'v0.7.6', html_url: 'https://github.com.evil.example/x' },
  });
  assert.equal(lookalike.url, null);
});

test('invalid releases, missing tags and missing current versions are unavailable', () => {
  assert.deepEqual(
    releaseUpdateFrom({ currentVersion: '0.7.5', release: null }),
    { available: false, version: null, url: null },
  );
  assert.deepEqual(
    releaseUpdateFrom({ currentVersion: '0.7.5', release: { html_url: GITHUB_RELEASE } }),
    { available: false, version: null, url: GITHUB_RELEASE },
  );
  assert.deepEqual(
    releaseUpdateFrom({ currentVersion: '0.7.5', release: { tag_name: 'nightly', html_url: GITHUB_RELEASE } }),
    { available: false, version: null, url: GITHUB_RELEASE },
  );
  assert.deepEqual(
    releaseUpdateFrom({
      currentVersion: '0.7.5',
      release: { tag_name: 42, html_url: GITHUB_RELEASE },
    }),
    { available: false, version: null, url: GITHUB_RELEASE },
  );
  assert.deepEqual(
    releaseUpdateFrom({
      release: { tag_name: 'v0.7.6', html_url: GITHUB_RELEASE },
    }),
    { available: false, version: null, url: GITHUB_RELEASE },
  );
  assert.deepEqual(
    releaseUpdateFrom({
      currentVersion: '   ',
      release: { tag_name: 'v0.7.6', html_url: GITHUB_RELEASE },
    }),
    { available: false, version: null, url: GITHUB_RELEASE },
  );
});

test('build metadata does not change availability', () => {
  const checked = releaseUpdateFrom({
    currentVersion: '0.7.6',
    release: { tag_name: 'v0.7.6+build.5', html_url: GITHUB_RELEASE },
  });
  assert.equal(checked.available, false);
  assert.equal(parseReleaseVersion('v0.7.6+build.5'), '0.7.6+build.5');
});
