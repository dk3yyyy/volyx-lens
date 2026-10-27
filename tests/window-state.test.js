'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createWindowState,
  sanitizeWindowSize,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_WIDTH,
  MAX_HEIGHT,
} = require('../src/window-state');
const { dockBounds, DEFAULT_DOCK_SIZES } = require('../src/window-docking');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-lens-window-'));
}

test('a size the app cannot use is dropped rather than applied', () => {
  assert.equal(sanitizeWindowSize(null), null);
  assert.equal(sanitizeWindowSize('700x600'), null);
  assert.equal(sanitizeWindowSize({ width: 'wide', height: 600 }), null);
  assert.equal(sanitizeWindowSize({ width: Number.NaN, height: 600 }), null);
  assert.equal(sanitizeWindowSize({ width: MIN_WIDTH - 1, height: 700 }), null, 'a sliver is not restorable');
  assert.equal(sanitizeWindowSize({ width: 900, height: MIN_HEIGHT - 1 }), null);
  assert.deepEqual(sanitizeWindowSize({ width: 901.6, height: 640.2 }), { width: 902, height: 640 }, 'fractional pixels round');
  assert.deepEqual(sanitizeWindowSize({ width: 99_999, height: 99_999 }), { width: MAX_WIDTH, height: MAX_HEIGHT }, 'an absurd size is capped');
});

test('the size survives a round trip and is written privately', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'window-state.json');
  const state = createWindowState({ file });
  assert.equal(state.load(), null, 'nothing is remembered on the first launch');
  assert.deepEqual(state.save({ width: 880, height: 640 }), { width: 880, height: 640 });
  assert.deepEqual(state.load(), { width: 880, height: 640 });
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, 'window state is not world readable');
  }
  assert.deepEqual(fs.readdirSync(directory), ['window-state.json'], 'no temp file is left behind');
});

test('a damaged or oversized file falls back to the default window', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'window-state.json');
  fs.writeFileSync(file, '{ not json');
  assert.equal(createWindowState({ file }).load(), null);
  fs.writeFileSync(file, JSON.stringify({ width: 900, height: 700, padding: 'x'.repeat(4000) }));
  assert.equal(createWindowState({ file }).load(), null, 'an oversized file is not parsed');
  fs.writeFileSync(file, JSON.stringify({ width: 10, height: 10 }));
  assert.equal(createWindowState({ file }).load(), null, 'a stored sliver is refused');
});

test('saving an unusable size writes nothing', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'window-state.json');
  const state = createWindowState({ file });
  assert.equal(state.save({ width: 10, height: 10 }), null);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('the dock controller uses a remembered size instead of the built-in one', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const sizes = { ...DEFAULT_DOCK_SIZES, expanded: { width: 880, height: 640 } };
  const bounds = dockBounds({ workArea, side: 'top', anchor: { x: 960, y: 0 }, sizes });
  assert.equal(bounds.width, 880);
  assert.equal(bounds.height, 640);
  const clamped = dockBounds({ workArea: { x: 0, y: 0, width: 700, height: 500 }, side: 'top', anchor: { x: 350, y: 0 }, sizes });
  assert.ok(clamped.width <= 700 - (DEFAULT_DOCK_SIZES.edgeInset * 2), 'a size larger than the display is clamped to the work area');
});

test('the window is created, docked and saved with the remembered size', () => {
  assert.match(main, /require\('\.\/src\/window-state'\)/);
  assert.match(main, /createWindowState\(\{ file: path\.join\(currentUserDataPath, 'window-state\.json'\) \}\)/);
  assert.match(main, /function dockSizes\(\)/, 'one place resolves the sizes');
  assert.match(main, /const \{ width: W, height: H \} = dockSizes\(\)\.expanded/);
  assert.match(main, /const sizes = dockSizes\(\);/);
  assert.match(main, /dockBounds\(\{ workArea: display\.workArea, side, anchor: resolvedAnchor, collapsed, sizes \}\)/);
  assert.match(main, /railCenter\(currentBounds, windowDock\.side, sizes\)/);
  // A collapsed window is a 260pt rail, so remembering that would restore a
  // sliver: both the resize handler and the save itself refuse while collapsed.
  assert.match(main, /const scheduleWindowSizeSave = \(\) => \{[\s\S]{0,100}windowDock\.collapsed\) return;/);
  assert.match(main, /rememberWindowSize[\s\S]{0,140}windowDock\.collapsed/);
  assert.match(main, /windowState\.save\(/);
  // 'resized' only fires for a user-driven resize, and the quit path exits via
  // app.exit(0) which destroys the window without a 'close' event, so both have
  // to be covered or the size is read at launch and never written.
  assert.match(main, /win\.on\('resize', scheduleWindowSizeSave\)/);
  assert.match(main, /win\.on\('resized', scheduleWindowSizeSave\)/);
  assert.match(main, /app\.on\('before-quit',[\s\S]{0,240}saveWindowSizeNow\(\)/);
});
