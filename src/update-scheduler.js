'use strict';

// Periodic update checks, armed only while the user wants update notifications.
// The check itself lives in update-manager; this only decides when to call it, so
// the cadence is testable with injected timers instead of real six-hour waits.

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000;

function createUpdateScheduler({
  check,
  isEnabled = () => true,
  intervalMs = DEFAULT_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let running = false;
  let inFlight = false;

  function arm(delay) {
    timer = setTimer(tick, delay);
    // Never hold the app open just to poll for updates.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function run() {
    // A slow check must not stack up behind the next interval.
    if (inFlight) return;
    if (!isEnabled()) { stop(); return; }
    inFlight = true;
    try {
      await check();
    } catch {
      // check() already reports failures through the update state; a failed
      // background check stays silent rather than interrupting the user.
    } finally {
      inFlight = false;
    }
  }

  async function tick() {
    timer = null;
    await run();
    if (running && isEnabled()) arm(intervalMs);
  }

  function start() {
    if (running || !isEnabled()) return;
    running = true;
    arm(initialDelayMs);
  }

  function stop() {
    running = false;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  // Called when settings change: the toggle is the only thing that arms this.
  function sync() {
    if (isEnabled()) start();
    else stop();
  }

  return {
    start,
    stop,
    sync,
    isRunning: () => running,
    isChecking: () => inFlight,
  };
}

module.exports = { createUpdateScheduler, DEFAULT_INTERVAL_MS, DEFAULT_INITIAL_DELAY_MS };
