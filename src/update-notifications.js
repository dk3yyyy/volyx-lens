'use strict';

// Decides whether an update state transition deserves an OS notification. It is
// deliberately pure: the caller owns the previous state, the enabled setting, and
// the set of keys it has already announced. A periodic check reaches 'available'
// again every cycle, so an edge alone is not enough to stop a notification firing
// every six hours — the key is what makes it once per version.

const AVAILABLE_TITLE = 'Volyx Lens update available';
const READY_TITLE = 'Volyx Lens update ready to install';
const UNAVAILABLE_TITLE = 'Volyx Lens needs a manual update';

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

module.exports = { updateNotificationFor, notificationsEnabled, notificationKey, AVAILABLE_TITLE, READY_TITLE, UNAVAILABLE_TITLE };
