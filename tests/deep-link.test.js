'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseDeepLink,
  SETTINGS_PANES,
  MAX_DEEP_LINK_LENGTH,
} = require('../src/deep-link');

const root = path.join(__dirname, '..');

function accepted(rawUrl) {
  const result = parseDeepLink(rawUrl);
  assert.equal(result.ok, true, `${rawUrl} should be accepted (got ${JSON.stringify(result)})`);
  return result;
}

function rejected(rawUrl) {
  const result = parseDeepLink(rawUrl);
  assert.equal(result.ok, false, `${rawUrl} should be rejected (got ${JSON.stringify(result)})`);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'a rejection always explains itself');
  return result.reason;
}

// -------- accepted routes --------

test('updates route is accepted with and without the update alias', () => {
  assert.deepEqual(accepted('volyxlens://updates'), { ok: true, route: 'updates', query: {} });
  assert.deepEqual(accepted('volyxlens://update'), { ok: true, route: 'updates', query: {} });
});

test('every documented route resolves to its canonical name', () => {
  assert.deepEqual(accepted('volyxlens://release'), { ok: true, route: 'release', query: {} });
  assert.deepEqual(accepted('volyxlens://settings'), { ok: true, route: 'settings', query: {} });
  assert.deepEqual(accepted('volyxlens://open'), { ok: true, route: 'open', query: {} });
});

test('the scheme and host are matched case-insensitively', () => {
  assert.deepEqual(accepted('VOLYXLENS://UPDATES'), { ok: true, route: 'updates', query: {} });
  assert.deepEqual(accepted('VolyxLens://Release'), { ok: true, route: 'release', query: {} });
});

test('a bare trailing slash and a trailing hash mark are tolerated', () => {
  assert.deepEqual(accepted('volyxlens://settings/'), { ok: true, route: 'settings', query: {} });
  assert.deepEqual(accepted('volyxlens://updates#'), { ok: true, route: 'updates', query: {} });
});

test('surrounding whitespace from an argv handoff is trimmed', () => {
  assert.deepEqual(accepted('  volyxlens://open  '), { ok: true, route: 'open', query: {} });
});

test('the settings pane allowlist matches the sections in renderer/index.html', () => {
  assert.deepEqual([...SETTINGS_PANES], ['providers', 'listening', 'context', 'shortcuts', 'updates', 'help']);
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const sections = [...html.matchAll(/data-settings-section="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sections, [...SETTINGS_PANES], 'the parser allowlist must track the real Settings sections');
});

test('every Settings pane in the allowlist is accepted', () => {
  for (const pane of SETTINGS_PANES) {
    assert.deepEqual(accepted(`volyxlens://settings?pane=${pane}`), { ok: true, route: 'settings', query: { pane } });
  }
});

test('the query is a plain object of string values only', () => {
  const result = accepted('volyxlens://settings?pane=updates');
  assert.equal(Object.getPrototypeOf(result.query), Object.prototype);
  for (const value of Object.values(result.query)) assert.equal(typeof value, 'string');
});

// -------- scheme and transport rejections --------

test('other schemes are rejected, including disguised executions', () => {
  for (const rawUrl of [
    'https://example.com/updates',
    'http://volyxlens://updates',
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/updates',
  ]) {
    assert.equal(rejected(rawUrl), 'unsupported-scheme', rawUrl);
  }
});

test('userinfo and credentials in the authority are rejected', () => {
  for (const rawUrl of [
    'volyxlens://user:pass@updates',
    'volyxlens://user@updates',
    'volyxlens://@updates',
    'volyxlens://:pass@settings',
    'volyxlens://user%40host@open',
  ]) {
    assert.equal(rejected(rawUrl), 'userinfo', rawUrl);
  }
});

test('a port in the authority is rejected', () => {
  assert.equal(rejected('volyxlens://updates:443'), 'unexpected-port');
});

// -------- host, path, fragment rejections --------

test('unknown hosts are rejected', () => {
  for (const rawUrl of [
    'volyxlens://admin',
    'volyxlens://updates.',
    'volyxlens://updates-evil',
    'volyxlens://providers',
    'volyxlens://updates%2e',
  ]) {
    assert.equal(rejected(rawUrl), 'unknown-host', rawUrl);
  }
});

test('a link without an authority host is rejected', () => {
  for (const rawUrl of ['volyxlens:updates', 'volyxlens:///updates', 'volyxlens://']) {
    assert.equal(rejected(rawUrl), 'missing-host', rawUrl);
  }
});

test('paths beyond the fixed endpoints are rejected', () => {
  for (const rawUrl of ['volyxlens://updates/extra', 'volyxlens://open/compose', 'volyxlens://settings/providers']) {
    assert.equal(rejected(rawUrl), 'unsupported-path', rawUrl);
  }
});

test('fragments are rejected so they cannot carry a second destination', () => {
  for (const rawUrl of ['volyxlens://updates#javascript:alert(1)', 'volyxlens://settings#https://evil.example']) {
    assert.equal(rejected(rawUrl), 'unsupported-fragment', rawUrl);
  }
});

// -------- parameter rejections --------

test('an absolute URL smuggled as a parameter is rejected', () => {
  for (const rawUrl of [
    'volyxlens://updates?url=https://evil.example',
    'volyxlens://release?next=file:///etc/passwd',
    'volyxlens://open?target=javascript:alert(1)',
    'volyxlens://settings?pane=https://evil.example',
    'volyxlens://settings?pane=//evil.example',
    'volyxlens://updates?url=https%3A%2F%2Fevil.example',
    'volyxlens://updates?url=%2F%2Fevil.example',
  ]) {
    assert.equal(rejected(rawUrl), 'absolute-url-value', rawUrl);
  }
});

test('routes that take no parameters reject every other key', () => {
  for (const rawUrl of [
    'volyxlens://updates?pane=updates',
    'volyxlens://release?version=0.7.6',
    'volyxlens://open?focus=true',
    'volyxlens://settings?section=providers',
    'volyxlens://settings?PANE=updates',
  ]) {
    assert.equal(rejected(rawUrl), 'unsupported-param', rawUrl);
  }
});

test('duplicate parameters are rejected instead of picking one', () => {
  assert.equal(rejected('volyxlens://settings?pane=updates&pane=help'), 'duplicate-param');
});

test('panes outside the allowlist are rejected', () => {
  for (const rawUrl of [
    'volyxlens://settings?pane=admin',
    'volyxlens://settings?pane=',
    'volyxlens://settings?pane=Providers',
    'volyxlens://settings?pane=../providers',
  ]) {
    assert.equal(rejected(rawUrl), 'unsupported-pane', rawUrl);
  }
});

test('prototype-polluting parameter names never reach the query object', () => {
  assert.equal(rejected('volyxlens://settings?__proto__=polluted'), 'unsupported-param');
  assert.equal(rejected('volyxlens://settings?constructor=1'), 'unsupported-param');
  assert.equal({}.polluted, undefined);
});

// -------- malformed and oversized input --------

test('non-string and empty input is rejected', () => {
  for (const value of [undefined, null, 42, {}, [], true]) {
    assert.equal(rejected(value), 'not-a-string');
  }
  assert.equal(rejected(''), 'empty');
  assert.equal(rejected('   '), 'empty');
});

test('malformed URLs are rejected without throwing', () => {
  assert.equal(rejected('volyxlens://['), 'malformed');
  assert.equal(rejected('volyxlens://updates\n?pane=updates'), 'unsupported-param');
});

test('input is capped at 2048 characters before parsing', () => {
  const prefix = 'volyxlens://updates?pad=';
  const atLimit = prefix + 'a'.repeat(MAX_DEEP_LINK_LENGTH - prefix.length);
  assert.equal(atLimit.length, MAX_DEEP_LINK_LENGTH);
  // The oversized rule is about length, so a 2048-character link is judged on
  // its contents instead.
  assert.equal(rejected(atLimit), 'unsupported-param');

  const overLimit = `${atLimit}a`;
  assert.equal(overLimit.length, MAX_DEEP_LINK_LENGTH + 1);
  assert.equal(rejected(overLimit), 'too-long');
  assert.equal(rejected(` ${overLimit} `), 'too-long', 'padding cannot shrink an oversized input');
});

// -------- wiring --------

test('package.json registers the scheme for the installer', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.protocols, [{ name: 'Volyx Lens', schemes: ['volyxlens'] }]);
});

test('the preload allowlist exposes the new channel', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  assert.match(preload, /'deeplink:open'/);
  assert.match(preload, /allowed\s*=\s*\[[^\]]*'deeplink:open'/);
});

test('main wires each platform to the parser and never opens a link externally', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/src\/deep-link'\)/);
  assert.match(main, /if \(app\.isPackaged\) app\.setAsDefaultProtocolClient\('volyxlens'\)/);
  assert.match(main, /app\.on\('open-url'/);
  assert.match(main, /deepLinkFromArgv\(argv\)/);
  assert.match(main, /deepLinkFromArgv\(process\.argv\)/);
  assert.match(main, /send\('update:open', \{ kind: 'deeplink' \}\)/);
  assert.match(main, /send\('deeplink:open'/);
  assert.doesNotMatch(main, /shell\.openExternal\([^)]*(?:deepLink|parsed|rawUrl)/);
});

test('the renderer handles the new channel on the requested pane', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  assert.match(renderer, /volyxLens\.on\('deeplink:open'/);
  assert.match(renderer, /selectSettingsSection\(pane/);
});
