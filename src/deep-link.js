'use strict';

// Deep links are an untrusted input path: the OS hands this URL to the app on
// behalf of whatever page or installer asked for it, so the parser recognises a
// fixed set of destinations and returns only an inert description of them. No
// Electron import lives here, nothing is resolved against the filesystem, and
// none of the returned values is ever handed back to the OS — main.js decides
// what happens, and the renderer only ever receives a route name and a pane id.

const SCHEME = 'volyxlens:';
// A link is a routing hint, not a payload. Anything longer is refused before the
// URL parser runs so a hostile caller cannot force expensive parsing.
const MAX_DEEP_LINK_LENGTH = 2048;

// Mirrors the data-settings-section values in renderer/index.html. A pane id is
// an allowlist entry, never a selector or a URL, so it cannot widen the surface
// if a link is hostile.
const SETTINGS_PANES = Object.freeze(['providers', 'listening', 'context', 'shortcuts', 'updates', 'help']);

// Host -> canonical route. `update` is an accepted spelling alias because
// release notes and support replies naturally say either word; the parser always
// reports the canonical `updates` so callers need only one branch.
const ROUTES = Object.freeze({
  updates: 'updates',
  update: 'updates',
  release: 'release',
  settings: 'settings',
  open: 'open',
});

// Query keys each route may carry. Everything else is refused rather than
// ignored: silently dropping a parameter hides a caller using the link for
// something the app does not support (usually a redirect target).
const QUERY_KEYS_BY_ROUTE = Object.freeze({
  updates: Object.freeze([]),
  release: Object.freeze([]),
  settings: Object.freeze(['pane']),
  open: Object.freeze([]),
});

function fail(reason) {
  return { ok: false, reason };
}

// The authority is what sits between "//" and the first /, ? or #. URL parsing
// exposes username/password, but an explicit "@" with no credentials at all
// (volyxlens://@updates) parses as empty, so the raw authority is checked too.
function authorityOf(rawUrl) {
  const schemeEnd = rawUrl.indexOf(':');
  if (schemeEnd === -1) return '';
  const afterScheme = rawUrl.slice(schemeEnd + 1);
  if (!afterScheme.startsWith('//')) return '';
  const rest = afterScheme.slice(2);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

// Any absolute or protocol-relative URL is disqualifying. A route parameter can
// only be an identifier, so accepting "https://…" here would exist solely to let
// a link smuggle a target through to something that opens URLs.
function looksLikeAbsoluteUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.startsWith('//')) return true;
  try {
    return new URL(value).protocol !== '';
  } catch {
    return false;
  }
}

function parseDeepLink(rawUrl) {
  if (typeof rawUrl !== 'string') return fail('not-a-string');
  // Length is checked on the raw input, before trimming, so an oversized string
  // can never be made acceptable by surrounding whitespace.
  if (rawUrl.length > MAX_DEEP_LINK_LENGTH) return fail('too-long');
  const raw = rawUrl.trim();
  if (!raw) return fail('empty');

  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail('malformed');
  }

  // The scheme is the only door in. Comparing after URL normalisation also
  // covers javascript:, file:, data:, and any other scheme with one rule.
  if (url.protocol !== SCHEME) return fail('unsupported-scheme');

  // Links never carry accounts. Checking both the parsed credentials and the raw
  // authority catches the empty-userinfo form that parses as no credentials.
  if (url.username !== '' || url.password !== '' || authorityOf(raw).includes('@')) return fail('userinfo');

  // A protocol URL has no host:port authority; a port is a sign the caller is
  // reusing a web URL shape the app never advertised.
  if (url.port !== '') return fail('unexpected-port');

  if (!url.hostname) return fail('missing-host');
  // Non-special schemes preserve the case of the host, so lowercasing here is
  // what makes volyxlens://UPDATES work as documented.
  const host = url.hostname.toLowerCase();
  const route = Object.hasOwn(ROUTES, host) ? ROUTES[host] : null;
  if (!route) return fail('unknown-host');

  // Routes are fixed endpoints: a path or fragment can only be an attempt to
  // widen the surface. A bare trailing slash is tolerated because links pasted
  // from a browser or chat client routinely pick one up.
  if (url.pathname !== '' && url.pathname !== '/') return fail('unsupported-path');
  if (url.hash !== '') return fail('unsupported-fragment');

  const query = {};
  const seen = new Set();
  const allowed = QUERY_KEYS_BY_ROUTE[route];
  for (const [key, value] of url.searchParams) {
    // Values are screened for absolute URLs before the key allowlist so a
    // smuggled target is reported as exactly that, even when its key is unknown.
    if (looksLikeAbsoluteUrl(value)) return fail('absolute-url-value');
    if (!allowed.includes(key)) return fail('unsupported-param');
    if (seen.has(key)) return fail('duplicate-param');
    seen.add(key);
    if (key === 'pane') {
      if (!SETTINGS_PANES.includes(value)) return fail('unsupported-pane');
      query.pane = value;
    }
  }

  // A plain object with string values only: callers can spread it into an IPC
  // payload without ever seeing a URL object, array, or inherited key.
  return { ok: true, route, query };
}

module.exports = { parseDeepLink, SETTINGS_PANES, MAX_DEEP_LINK_LENGTH };
