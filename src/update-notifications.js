'use strict';

// Decides whether an update state transition deserves an OS notification. It is
// deliberately pure: the caller owns the previous state, the enabled setting, and
// the set of keys it has already announced. A periodic check reaches 'available'
// again every cycle, so an edge alone is not enough to stop a notification firing
// every six hours — the key is what makes it once per version.

const AVAILABLE_TITLE = 'Volyx Lens update available';
const READY_TITLE = 'Volyx Lens update ready to install';
const UNAVAILABLE_TITLE = 'Volyx Lens needs a manual update';

// Announced keys are persisted by the settings store so a relaunch on the same
// version does not repeat the banner. The list is bookkeeping, not history: a
// release older than the last few announcements may be announced again, which
// is harmless, whereas an unbounded list would grow for the life of the install.
const NOTIFIED_UPDATE_KEY_LIMIT = 10;
const NOTIFIED_UPDATE_KINDS = new Set(['available', 'ready', 'unavailable']);
// Versions come from update-manager's safeVersion (digits, dots, and a semver
// pre-release/build suffix) or the literal 'unknown'. This excludes separators,
// whitespace, and control characters so one stored entry can never masquerade
// as another key.
const NOTIFIED_UPDATE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

function isNotifiedUpdateKey(value) {
  if (typeof value !== 'string' || value.length > 96) return false;
  const separator = value.indexOf(':');
  if (separator <= 0) return false;
  const kind = value.slice(0, separator);
  const version = value.slice(separator + 1);
  return NOTIFIED_UPDATE_KINDS.has(kind) && NOTIFIED_UPDATE_VERSION.test(version);
}

// Unknown shapes and unknown keys are dropped rather than repaired: the file is
// user-writable, and anything that is not a key this module could have produced
// must never reach the announcement path. Keeps the newest entries and treats a
// repeated key as newly announced so the cap evicts the genuinely oldest one.
function sanitizeNotifiedUpdateKeys(value, limit = NOTIFIED_UPDATE_KEY_LIMIT) {
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : NOTIFIED_UPDATE_KEY_LIMIT;
  if (!Array.isArray(value)) return [];
  const unique = new Map();
  for (const entry of value) {
    if (!isNotifiedUpdateKey(entry)) continue;
    unique.delete(entry);
    unique.set(entry, true);
  }
  return [...unique.keys()].slice(-max);
}

function appendNotifiedUpdateKey(keys, key, limit = NOTIFIED_UPDATE_KEY_LIMIT) {
  // The sanitizer drops an invalid key, so a bad caller cannot widen what the
  // settings file is allowed to carry.
  return sanitizeNotifiedUpdateKeys([...(Array.isArray(keys) ? keys : []), key], limit);
}

function notificationsEnabled(settings) {
  const notifications = settings && settings.notifications;
  return !(notifications && notifications.updates === false);
}

function notificationKey(kind, version) {
  return `${kind}:${version || 'unknown'}`;
}

function updateNotificationFor({ previous, next, enabled = true } = {}) {
  if (enabled !== true || !next || typeof next !== 'object') return null;
  // A build that cannot install updates has nothing to offer when clicked.
  if (next.supported !== true) return null;
  const before = previous && previous.status;

  if (next.status === 'available' && before !== 'available') {
    const version = next.availableVersion || null;
    return {
      kind: 'available',
      version,
      key: notificationKey('available', version),
      title: AVAILABLE_TITLE,
      body: version ? `Version ${version} is available. Open Settings to download it.` : 'A new version is available. Open Settings to download it.',
    };
  }

  // A build that lost its update channel (unsigned Windows from 0.7.5) will never
  // become 'available', so without this it would poll forever and say nothing. The
  // user has to install by hand, and nobody opens Settings to find that out.
  if (next.status === 'unavailable' && before !== 'unavailable') {
    return {
      kind: 'unavailable',
      version: null,
      key: notificationKey('unavailable', next.currentVersion),
      title: UNAVAILABLE_TITLE,
      body: 'This build can no longer update itself. Open Settings to download the newest installer.',
    };
  }

  if (next.status === 'downloaded' && before !== 'downloaded') {
    const version = next.availableVersion || null;
    return {
      kind: 'ready',
      version,
      key: notificationKey('ready', version),
      title: READY_TITLE,
      body: version ? `Version ${version} is ready. Restart Volyx Lens to finish installing.` : 'The update is ready. Restart Volyx Lens to finish installing.',
    };
  }

  return null;
}

module.exports = {
  updateNotificationFor,
  notificationsEnabled,
  notificationKey,
  isNotifiedUpdateKey,
  sanitizeNotifiedUpdateKeys,
  appendNotifiedUpdateKey,
  NOTIFIED_UPDATE_KEY_LIMIT,
  AVAILABLE_TITLE,
  READY_TITLE,
  UNAVAILABLE_TITLE,
};
