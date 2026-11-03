'use strict';

// Renderer crash recovery policy.
//
// The overlay is a frameless, transparent, always-on-top window whose
// click-through state is driven by the renderer: when the renderer dies, the
// main process stops receiving `mouse:ignore` messages and the invisible window
// keeps swallowing every click. The main process therefore has to bring the
// renderer back on its own — but a crash loop must not reload forever.
//
// Only the reload budget lives here, so it can be tested without Electron (and
// without a window). main.js owns the actual reload, pass-through and quit.

const DEFAULT_CRASH_WINDOW_MS = 60 * 1000;
const DEFAULT_CRASH_MAX_RELOADS = 2;

// Decides what to do after a renderer crash.
//
// `crashes` is the timestamp list of the reloads already performed (not every
// crash: the one that exhausts the budget is the quit decision, not a reload).
// Returns `{ reload, crashes, recent }`: `reload` is false once `maxReloads`
// reloads happened strictly inside the last `windowMs`, and `crashes` is the
// pruned list to keep for the next call.
function shouldReloadAfterCrash({
  crashes = [],
  now = Date.now(),
  windowMs = DEFAULT_CRASH_WINDOW_MS,
  maxReloads = DEFAULT_CRASH_MAX_RELOADS,
} = {}) {
  const recent = (Array.isArray(crashes) ? crashes : [])
    // A timestamp in the future (the wall clock moved backwards) stays counted:
    // the budget then errs towards quitting instead of reloading in a loop.
    .filter((at) => Number.isFinite(at) && now - at < windowMs);
  const reload = recent.length < maxReloads;
  return {
    reload,
    // Keep the list pruned on every decision so it cannot grow without bound.
    // An exhausted budget keeps the old entries: if the quit path is somehow
    // interrupted, the next crash inside the window quits again rather than
    // silently restarting the loop with a fresh budget.
    crashes: reload ? [...recent, now] : recent,
    recent: recent.length,
  };
}

module.exports = {
  shouldReloadAfterCrash,
  DEFAULT_CRASH_WINDOW_MS,
  DEFAULT_CRASH_MAX_RELOADS,
};
