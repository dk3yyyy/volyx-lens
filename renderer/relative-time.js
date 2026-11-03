// Relative "last checked" labels for the Updates pane.
//
// Loaded as a plain script by the renderer and required directly by tests, the
// same way renderer/notes-markup.js and renderer/plain-math.js are. Keeping the
// formatting here rather than inline in renderer.js makes the thresholds a pure
// function that can be tested without an Electron window.
(function exposeRelativeTime(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.volyxLensRelativeTime = api;
})(typeof window !== 'undefined' ? window : null, () => {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  function dateLabel(timestamp) {
    // Short, locale-aware date. The pane should stay readable at any distance,
    // and an absolute timestamp for a check that happened long ago is more
    // useful than "37 days ago".
    return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // Returns the relative part only ('' when there is no timestamp to describe).
  // Thresholds are deliberately coarse: "2 minutes ago" is precise enough for a
  // background check, and anything a day or older becomes a date instead of a
  // slowly rotting relative label.
  function formatRelativeTime(value, now = Date.now()) {
    const timestamp = Number(value);
    // Null, undefined, NaN, Infinity, negatives and the 0 sentinel all mean the
    // same thing: no finished check has been recorded.
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    // A clock that moved backwards after the check (or a timestamp slightly in
    // the future) must not render "-1 minutes ago".
    const elapsed = Math.max(0, current - timestamp);
    if (elapsed < MINUTE) return 'just now';
    if (elapsed < HOUR) {
      const minutes = Math.floor(elapsed / MINUTE);
      return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    }
    if (elapsed < DAY) {
      const hours = Math.floor(elapsed / HOUR);
      return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    }
    return dateLabel(timestamp);
  }

  // The full status line used by the Updates pane.
  function formatLastChecked(value, now = Date.now()) {
    const relative = formatRelativeTime(value, now);
    return relative ? `Last checked ${relative}` : 'Never checked';
  }

  return { formatRelativeTime, formatLastChecked };
});
