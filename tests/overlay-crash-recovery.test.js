'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  shouldReloadAfterCrash,
  DEFAULT_CRASH_WINDOW_MS,
  DEFAULT_CRASH_MAX_RELOADS,
} = require('../src/renderer-crash-recovery');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const policySource = fs.readFileSync(path.join(root, 'src', 'renderer-crash-recovery.js'), 'utf8');

// A fixed instant keeps every budget assertion independent of the wall clock.
const NOW = 1_000_000;

test('the first crash reloads the renderer', () => {
  const decision = shouldReloadAfterCrash({ crashes: [], now: NOW, windowMs: 60000, maxReloads: 2 });
  assert.equal(decision.reload, true);
  assert.deepEqual(decision.crashes, [NOW], 'the reload is recorded for the next decision');
  assert.equal(decision.recent, 0);
});

test('two reloads are allowed inside the window and the third crash gives up', () => {
  const first = shouldReloadAfterCrash({ crashes: [], now: NOW, windowMs: 60000, maxReloads: 2 });
  const second = shouldReloadAfterCrash({ crashes: first.crashes, now: NOW + 1000, windowMs: 60000, maxReloads: 2 });
  const third = shouldReloadAfterCrash({ crashes: second.crashes, now: NOW + 2000, windowMs: 60000, maxReloads: 2 });

  assert.equal(first.reload, true);
  assert.equal(second.reload, true, 'the second crash in the window still gets a reload');
  assert.equal(third.reload, false, 'the third crash in the window is the quit decision');
  assert.equal(third.recent, 2);
  assert.deepEqual(third.crashes, second.crashes, 'a quit decision is not recorded as a reload');
});

test('a crash outside the window frees the budget again', () => {
  const crashes = [NOW, NOW + 1000];
  const exhausted = shouldReloadAfterCrash({ crashes, now: NOW + 2000, windowMs: 60000, maxReloads: 2 });
  assert.equal(exhausted.reload, false);

  // Once the two recorded reloads age out, the next crash starts a new budget.
  const later = shouldReloadAfterCrash({
    crashes: exhausted.crashes.concat(NOW + 2000),
    now: NOW + 63001,
    windowMs: 60000,
    maxReloads: 2,
  });
  assert.equal(later.reload, true);
  assert.deepEqual(later.crashes, [NOW + 63001], 'only the new reload survives the prune');
});

test('the window boundary is exclusive', () => {
  const justInside = shouldReloadAfterCrash({ crashes: [NOW - 59999], now: NOW, windowMs: 60000, maxReloads: 2 });
  assert.equal(justInside.recent, 1, 'a crash 59.999s old still counts');
  const exactlyAtEdge = shouldReloadAfterCrash({ crashes: [NOW - 60000], now: NOW, windowMs: 60000, maxReloads: 2 });
  assert.equal(exactlyAtEdge.recent, 0, 'a crash exactly windowMs old has left the window');
});

test('a backwards clock cannot unspend the budget', () => {
  // A timestamp in the future (now moved backwards) is treated as recent, so
  // recovery errs towards quitting rather than reloading in a loop.
  const decision = shouldReloadAfterCrash({ crashes: [NOW + 5000], now: NOW, windowMs: 60000, maxReloads: 1 });
  assert.equal(decision.reload, false);
  assert.equal(decision.recent, 1);
});

test('malformed timestamps are ignored instead of poisoning the budget', () => {
  const decision = shouldReloadAfterCrash({
    crashes: [NaN, null, undefined, 'yesterday', NOW],
    now: NOW,
    windowMs: 60000,
    maxReloads: 2,
  });
  assert.equal(decision.recent, 1);
  assert.deepEqual(decision.crashes, [NOW, NOW]);

  const notAnArray = shouldReloadAfterCrash({ crashes: { length: 9 }, now: NOW, windowMs: 60000, maxReloads: 2 });
  assert.equal(notAnArray.reload, true);
  assert.deepEqual(notAnArray.crashes, [NOW]);
});

test('the shipped policy is two reloads per minute and needs no Electron', () => {
  assert.equal(DEFAULT_CRASH_WINDOW_MS, 60 * 1000);
  assert.equal(DEFAULT_CRASH_MAX_RELOADS, 2);
  const decision = shouldReloadAfterCrash({ crashes: [] });
  assert.equal(decision.reload, true);
  assert.equal(decision.crashes.length, 1);
  assert.doesNotMatch(policySource, /require\(['"]electron['"]\)/, 'the policy stays pure and testable');
});

test('render-process-gone forces pass-through, reloads, and quits when the budget is spent', () => {
  const start = main.indexOf("win.webContents.on('render-process-gone'");
  assert.ok(start > -1, 'the crash handler is registered');
  const block = main.slice(start, start + 3000);

  assert.match(block, /forceOverlayPassThrough\(\)/, 'the window stops swallowing clicks immediately');
  assert.ok(
    block.indexOf('forceOverlayPassThrough()') < block.indexOf('shouldReloadAfterCrash('),
    'pass-through is forced before the reload decision',
  );
  assert.match(block, /shouldReloadAfterCrash\(\{[\s\S]*?windowMs: DEFAULT_CRASH_WINDOW_MS[\s\S]*?maxReloads: DEFAULT_CRASH_MAX_RELOADS/);
  assert.match(block, /win\.reload\(\)/, 'the reload path is called');
  assert.match(block, /quitAfterFatalError\(/, 'exhaustion fails visibly instead of reloading forever');
  assert.match(block, /if \(shutdownPromise\) return;/, 'a crash during shutdown does not race the quit');
  assert.match(block, /rendererCrashes/, 'the budget persists across crashes');
  // The existing behaviour that capture stops on a gone renderer is kept.
  assert.match(block, /if \(state\.capturing\) setCapturing\(false\)/);
});

test('click-through is restored to the renderer when it reports ready', () => {
  const readyStart = main.indexOf("onTrusted('app:renderer-ready'");
  assert.ok(readyStart > -1);
  const readyBlock = main.slice(readyStart, main.indexOf("onTrusted('app:quit'", readyStart));
  assert.match(readyBlock, /releaseOverlayPassThrough\(\)/);

  // Recovery reuses the renderer's own `mouse:ignore` mechanism rather than
  // adding a second way to ignore the mouse.
  const passThrough = main.slice(main.indexOf('function setOverlayPassThrough('), main.indexOf('function forceOverlayPassThrough('));
  assert.match(passThrough, /win\.setIgnoreMouseEvents\(active === true, \{ forward: true \}\)/);
});

test('both process-level handlers are registered and log through the renderer forwarder', () => {
  const start = main.indexOf("process.on('unhandledRejection'");
  assert.ok(start > -1, 'unhandledRejection is handled');
  const block = main.slice(start, main.indexOf("onTrusted('ui:modal-state'", start));

  assert.match(block, /process\.on\('uncaughtException'/);
  assert.match(block, /rendererLog\.forward\(/, 'main errors go through the same capped forwarder as renderer logs');
  assert.match(block, /boundedProcessError\(/, 'the forwarded message is length-bounded');
  assert.match(block, /unhandledRejection[\s\S]*?if \(win && !win\.isDestroyed\(\)\) return;[\s\S]*?quitAfterFatalError\(/,
    'an uncaught exception keeps running with a live window and quits without one');

  const fatalStart = main.indexOf('function quitAfterFatalError(');
  assert.ok(fatalStart > -1);
  const fatalBlock = main.slice(fatalStart, main.indexOf('function createWindow(', fatalStart));
  assert.match(fatalBlock, /shutdownAll\(\)\.finally\(\(\) => \{[\s\S]*?win\.destroy\(\)[\s\S]*?app\.quit\(\)/,
    'a windowless app cleans up, destroys the overlay and quits instead of going half-dead');
  assert.match(fatalBlock, /console\.error\(/, 'the line is logged before quitting');
});
