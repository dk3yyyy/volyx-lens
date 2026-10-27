'use strict';

// The expanded window size, remembered between launches.
//
// The dock controller owns position: it snaps the window to an edge and centres
// it on an anchor. Size is the user's, so it lives in its own small file rather
// than in the settings tree, which would drag it through the settings UI and its
// validation for no gain. A value that cannot be trusted is dropped and the
// built-in default is used, because a bad size here means an unusable window.

const path = require('node:path');
const nodeFs = require('node:fs');

// Matches the BrowserWindow minimums. Below them the window is a sliver; the
// dock controller has no way to make that usable.
const MIN_WIDTH = 500;
const MIN_HEIGHT = 480;
// Ceilings rather than work-area limits: the work area is unknown when the file
// is read, and the dock controller clamps to the display it lands on anyway.
const MAX_WIDTH = 4000;
const MAX_HEIGHT = 3000;
const MAX_FILE_BYTES = 1024;

function sanitizeWindowSize(value) {
  if (!value || typeof value !== 'object') return null;
  const width = Math.round(Number(value.width));
  const height = Math.round(Number(value.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return null;
  return {
    width: Math.min(width, MAX_WIDTH),
    height: Math.min(height, MAX_HEIGHT),
  };
}

function createWindowState({ file, fsImpl = nodeFs } = {}) {
  if (!file || typeof file !== 'string') throw new Error('Window state requires a file path.');

  function load() {
    try {
      const stat = fsImpl.statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
      return sanitizeWindowSize(JSON.parse(fsImpl.readFileSync(file, 'utf8')));
    } catch {
      // Missing, unreadable or malformed: the default window is fine.
      return null;
    }
  }

  function save(size) {
    const clean = sanitizeWindowSize(size);
    if (!clean) return null;
    const tmp = `${file}.${process.pid}-${Math.random().toString(16).slice(2, 8)}.tmp`;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
      return clean;
    } catch {
      try { fsImpl.unlinkSync(tmp); } catch {}
      return null;
    }
  }

  return { load, save };
}

module.exports = {
  createWindowState,
  sanitizeWindowSize,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_WIDTH,
  MAX_HEIGHT,
};
