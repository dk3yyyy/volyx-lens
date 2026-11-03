'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateScheduler, shouldCheckOnResume, DEFAULT_INTERVAL_MS } = require('../src/update-scheduler');

function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimer(fn, delay) { const key = ++id; pending.set(key, { fn, delay }); return key; },
    clearTimer(key) { pending.delete(key); },
    delays() { return [...pending.values()].map((entry) => entry.delay); },
    async fire() {
      const entry = [...pending.entries()].pop();
      assert.ok(entry, 'a timer is armed');
      pending.delete(entry[0]);
      await entry[1].fn();
      return entry[1].delay;
    },
  };
}

function build({ enabled = true, check = async () => {}, timers = fakeTimers(), now = Date.now } = {}) {
  const scheduler = createUpdateScheduler({
    check,
    isEnabled: () => enabled,
    intervalMs: 5000,
    initialDelayMs: 1000,
    resumeDelayMs: 250,
    now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { scheduler, timers };
}

test('a check is scheduled shortly after launch, then every interval', async () => {
  let calls = 0;
  const { scheduler, timers } = build({ check: async () => { calls += 1; } });
  scheduler.start();
  assert.deepEqual(timers.delays(), [1000], 'first check waits for the initial delay');
  await timers.fire();
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays(), [5000], 'the next check is a full interval away');
});

test('a failing check stays silent and keeps the schedule alive', async () => {
  let calls = 0;
  const { scheduler, timers } = build({ check: async () => { calls += 1; throw new Error('offline'); } });
  scheduler.start();
  await timers.fire();
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays(), [5000]);
});

test('nothing is scheduled while the preference is off', () => {
  const { scheduler, timers } = build({ enabled: false });
  scheduler.start();
  assert.deepEqual(timers.delays(), []);
  assert.equal(scheduler.isRunning(), false);
});

test('turning the preference off cancels the pending check', async () => {
  let enabled = true;
  const timers = fakeTimers();
  const scheduler = createUpdateScheduler({
    check: async () => {},
    isEnabled: () => enabled,
    intervalMs: 5000,
    initialDelayMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  scheduler.start();
  assert.deepEqual(timers.delays(), [1000]);
  enabled = false;
  scheduler.sync();
  assert.deepEqual(timers.delays(), []);
  assert.equal(scheduler.isRunning(), false);
});

test('turning the preference on arms the first check', () => {
  let enabled = false;
  const timers = fakeTimers();
  const scheduler = createUpdateScheduler({
    check: async () => {},
    isEnabled: () => enabled,
    intervalMs: 5000,
    initialDelayMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  scheduler.sync();
  assert.deepEqual(timers.delays(), []);
  enabled = true;
  scheduler.sync();
  assert.deepEqual(timers.delays(), [1000]);
});

test('a check that finishes after the switch is off does not re-arm', async () => {
  let enabled = true;
  let release = null;
  const timers = fakeTimers();
  const scheduler = createUpdateScheduler({
    check: () => new Promise((resolve) => { release = resolve; }),
    isEnabled: () => enabled,
    intervalMs: 5000,
    initialDelayMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  scheduler.start();
  const firing = timers.fire();
  enabled = false;
  scheduler.stop();
  release();
  await firing;
  assert.deepEqual(timers.delays(), [], 'no timer survives the stop');
});

test('a check spanning an off/on toggle leaves exactly one timer', async () => {
  let enabled = true;
  let calls = 0;
  let release = null;
  const timers = fakeTimers();
  const scheduler = createUpdateScheduler({
    // Only the first check hangs; once released, later checks are instant.
    check: () => {
      calls += 1;
      if (calls > 1) return Promise.resolve();
      return new Promise((resolve) => { release = resolve; });
    },
    isEnabled: () => enabled,
    intervalMs: 5000,
    initialDelayMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  scheduler.start();
  const firing = timers.fire();
  assert.equal(scheduler.isChecking(), true, 'the first check is in flight');

  enabled = false;
  scheduler.sync();
  enabled = true;
  scheduler.sync();

  release();
  await firing;

  assert.deepEqual(timers.delays(), [5000], 'one chain, not the fresh timer plus a re-arm');
  await timers.fire();
  assert.equal(calls, 2, 'the single live timer runs exactly one further check');
  assert.deepEqual(timers.delays(), [5000], 'the schedule stays a single chain');
});

test('stop is idempotent and safe before start', () => {
  const { scheduler, timers } = build();
  scheduler.stop();
  assert.deepEqual(timers.delays(), []);
  scheduler.start();
  scheduler.stop();
  scheduler.stop();
  assert.deepEqual(timers.delays(), []);
});

test('the default cadence is six hours', () => {
  assert.equal(DEFAULT_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test('the resume rule fires once the wall-clock interval is reached', () => {
  assert.equal(shouldCheckOnResume({ lastCheckAt: 1000, now: 7000, intervalMs: 5000 }), true, 'overdue');
  assert.equal(shouldCheckOnResume({ lastCheckAt: 1000, now: 6000, intervalMs: 5000 }), true, 'exactly due');
  assert.equal(shouldCheckOnResume({ lastCheckAt: 1000, now: 5999, intervalMs: 5000 }), false, 'not yet due');
});

test('the resume rule refuses a decision it cannot justify', () => {
  // No completed check this launch: start()'s initial timer still owns the first
  // check, so wake must not add one.
  assert.equal(shouldCheckOnResume({ lastCheckAt: null, now: 10000, intervalMs: 5000 }), false);
  assert.equal(shouldCheckOnResume({ lastCheckAt: undefined, now: 10000, intervalMs: 5000 }), false);
  assert.equal(shouldCheckOnResume({ lastCheckAt: '1000', now: 10000, intervalMs: 5000 }), false);
  assert.equal(shouldCheckOnResume({ lastCheckAt: 1000, now: NaN, intervalMs: 5000 }), false);
  assert.equal(shouldCheckOnResume({ lastCheckAt: 1000, now: 10000, intervalMs: 0 }), false);
  assert.equal(shouldCheckOnResume({ lastCheckAt: 1000, now: 10000, intervalMs: 'soon' }), false);
  assert.equal(shouldCheckOnResume(), false);
});

test('resuming after an overdue interval replaces the stale timer with a catch-up check', async () => {
  let currentTime = 1_000_000;
  let calls = 0;
  const { scheduler, timers } = build({
    check: async () => { calls += 1; },
    now: () => currentTime,
  });
  scheduler.start();
  await timers.fire();
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays(), [5000], 'the normal interval is armed');

  // A seven-hour sleep leaves the relative timer untouched, so wall time is the
  // only evidence that the interval was exceeded.
  currentTime += 7 * 60 * 60 * 1000;
  assert.equal(scheduler.onResume(), true);
  assert.deepEqual(timers.delays(), [250], 'a short catch-up delay replaces the stale timer');

  await timers.fire();
  assert.equal(calls, 2, 'the catch-up check actually ran');
  assert.deepEqual(timers.delays(), [5000], 'and the regular cadence resumes from it');
});

test('resuming early leaves the armed interval alone', async () => {
  let currentTime = 1_000_000;
  let calls = 0;
  const { scheduler, timers } = build({
    check: async () => { calls += 1; },
    now: () => currentTime,
  });
  scheduler.start();
  await timers.fire();

  currentTime += 1000; // one second into a five-second test interval
  assert.equal(scheduler.onResume(), false);
  assert.deepEqual(timers.delays(), [5000], 'the original timer is still the one that fires');
  assert.equal(calls, 1, 'no immediate extra check');
});

test('resuming while a check is in flight does not start a second one', async () => {
  let currentTime = 1_000_000;
  let calls = 0;
  let release = null;
  const { scheduler, timers } = build({
    check: () => {
      calls += 1;
      if (calls > 1) return Promise.resolve();
      return new Promise((resolve) => { release = resolve; });
    },
    now: () => currentTime,
  });
  scheduler.start();
  const firing = timers.fire();
  assert.equal(scheduler.isChecking(), true, 'the first check is in flight');

  currentTime += 7 * 60 * 60 * 1000;
  assert.equal(scheduler.onResume(), false, 'the in-flight check already owns the cadence');

  release();
  await firing;
  assert.equal(calls, 1, 'wake did not stack a second check');
  assert.deepEqual(timers.delays(), [5000], 'the finished check re-armed exactly one interval');
});

test('resuming before the first check leaves that first check to its own timer', () => {
  let currentTime = 1_000_000;
  const { scheduler, timers } = build({ now: () => currentTime });
  scheduler.start();
  currentTime += 7 * 60 * 60 * 1000;
  assert.equal(scheduler.onResume(), false);
  assert.deepEqual(timers.delays(), [1000]);
});
