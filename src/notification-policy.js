'use strict';

// The main process raises an OS notification when an update becomes available
// or ready. Whether that is welcome depends on what the user is doing right
// now, so the decision lives here as a pure function rather than inline in
// main.js: the caller supplies the signals, this module only decides.
//
// The result is { show, silent, defer }: show the banner now, make it silent,
// or keep it for a later attempt. Showing is always silent — this app exists to
// keep a call uninterrupted, and a banner chime cuts into the conversation.

function isNotice(notice) {
  return Boolean(notice) && typeof notice === 'object';
}

function updateNotificationPolicy({
  notice,
  notificationsSupported = true,
  focused = false,
  capturing = false,
  locked = false,
} = {}) {
  // No notice means nothing to announce. Checked first because every other flag
  // describes a notice that may not exist at all.
  if (!isNotice(notice)) return { show: false, silent: false, defer: false };

  // The platform cannot raise notifications. Drop rather than defer: no amount
  // of waiting makes the OS able to show it, so there is nothing to retry.
  if (notificationsSupported === false) return { show: false, silent: false, defer: false };

  // The screen is locked. Defer rather than drop — the update is still worth
  // announcing once the user is back and can actually see the banner.
  if (locked === true) return { show: false, silent: false, defer: true };

  // The user is in a call or already looking at the Updates pane. Either way
  // they are engaged: a banner would interrupt the call or repeat what is
  // already on screen, so drop it instead of retrying later.
  if (capturing === true || focused === true) return { show: false, silent: false, defer: false };

  // The default. Show, but never audible: a chime during a live call is exactly
  // the interruption this app is meant to prevent.
  return { show: true, silent: true, defer: false };
}

// A deferred notice is replayed once the screen unlocks. The key makes that
// replay once-only: the caller remembers the keys it has already announced, so
// a periodic check that rediscovers the same version stays quiet.
function noticeField(value, fallback) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return fallback;
  const trimmed = text.trim();
  return trimmed || fallback;
}

function deferredNoticeKey(notice) {
  const source = isNotice(notice) ? notice : {};
  // Missing fields still need a stable identity; 'update' and 'unknown' keep the
  // key well-formed without pretending to know a kind or version.
  const kind = noticeField(source.kind, 'update');
  const version = noticeField(source.version, 'unknown');
  return `${kind}:${version}`;
}

module.exports = { updateNotificationPolicy, deferredNoticeKey };
