'use strict';

// Periodic update checks, armed only while the user wants update notifications.
// The check itself lives in update-manager; this only decides when to call it, so
// the cadence is testable with injected timers instead of real six-hour waits.

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000;
// A resume check waits a moment for the network stack to come back up; firing
// into a half-awake network tends to fail and costs the user another interval.
const DEFAULT_RESUME_DELAY_MS = 5 * 1000;

// Wall-clock decision for a wake-up. The scheduler's relative timer measures
// time the machine is awake (suspend pauses it), so on resume the only question
// is whether the interval elapsed in wall time. A missing timestamp means no
// check has run in this launch yet; the timer armed by start() still owes that
// check, so resume must not add a second one.
function shouldCheckOnResume({ lastCheckAt, now, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const interval = Number(intervalMs);
  const current = Number(now);
  if (!Number.isFinite(interval) || interval <= 0) return false;
  if (!Number.isFinite(lastCheckAt) || !Number.isFinite(current)) return false;
  return current - lastCheckAt >= interval;
}

function createUpdateScheduler({
  check,
  isEnabled = () => true,
  intervalMs = DEFAULT_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  resumeDelayMs = DEFAULT_RESUME_DELAY_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let running = false;
  let inFlight = false;
  let lastCheckAt = null;

  function arm(delay) {
    // A check that was in flight across a stop/start cycle can re-arm after that
    // cycle already armed its own timer; clearing first keeps one chain, so the
    // cadence cannot double and stop() can still reach the only live handle.
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    timer = setTimer(tick, delay);
    // Never hold the app open just to poll for updates.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function run() {
    // A slow check must not stack up behind the next interval.
    if (inFlight) return;
    if (!isEnabled()) { stop(); return; }
    inFlight = true;
    // Recorded before the request so a slow or failing check still counts as the
    // last attempt; resume must not retry in a tight loop after a network error.
    lastCheckAt = now();
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

  // Called after the machine wakes. Returns true only when it armed a catch-up
  // check, which lets the caller log or assert the decision without duplicating
  // the wall-clock rule.
  function onResume() {
    if (!running || !isEnabled()) return false;
    // A running check re-arms the interval itself when it finishes; arming here
    // as well would leave two chains and double the cadence.
    if (inFlight) return false;
    if (!shouldCheckOnResume({ lastCheckAt, now: now(), intervalMs })) return false;
    // Replace the stale relative timer with a short one. Without this the app
    // would wait out a fresh interval after wake even though wall time already
    // crossed it.
    arm(resumeDelayMs);
    return true;
  }

  return {
    start,
    stop,
    sync,
    onResume,
    isRunning: () => running,
    isChecking: () => inFlight,
  };
}

module.exports = {
  createUpdateScheduler,
  shouldCheckOnResume,
  DEFAULT_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_RESUME_DELAY_MS,
};
