'use strict';

// Renderer log forwarding.
//
// The renderer can call this at any rate with any content, so the main process has to
// be the one that decides what reaches the log: control characters turn one line into
// a forged entry or a blank console, and an unbounded string fills the disk (VR-26).

const DEFAULTS = Object.freeze({
  maxChars: 2048,
  windowMs: 10000,
  maxPerWindow: 50,
});

function sanitizeRendererLog(value, maxChars = DEFAULTS.maxChars) {
  return String(value == null ? '' : value)
    // Newlines, carriage returns, tabs and the rest of the C0 range let a payload
    // pretend to be another log line; ESC also drives terminal control sequences.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .slice(0, maxChars);
}

function createRendererLogForwarder({
  maxChars = DEFAULTS.maxChars,
  windowMs = DEFAULTS.windowMs,
  maxPerWindow = DEFAULTS.maxPerWindow,
  write = () => {},
  now = Date.now,
} = {}) {
  let startedAt = 0;
  let count = 0;
  let dropped = 0;

  function forward(raw) {
    const at = now();
    if (at - startedAt > windowMs) {
      startedAt = at;
      count = 0;
      dropped = 0;
    }
    if (count >= maxPerWindow) {
      dropped += 1;
      // Say so once, then rarely, so the suppression itself cannot flood the log.
      if (dropped === 1 || dropped % 100 === 0) {
        write(`[renderer] ${dropped} log line${dropped === 1 ? '' : 's'} suppressed in the last ${Math.round(windowMs / 1000)}s`);
      }
      return { forwarded: false, dropped };
    }
    count += 1;
    write(`[renderer] ${sanitizeRendererLog(raw, maxChars)}`);
    return { forwarded: true, dropped };
  }

  return { forward, sanitize: (value) => sanitizeRendererLog(value, maxChars) };
}

module.exports = { createRendererLogForwarder, sanitizeRendererLog, DEFAULTS };
