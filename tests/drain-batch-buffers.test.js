'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { drainPendingAudio, DEFAULT_DEADLINE_MS } = require('../src/drain-batch-buffers');

// A fake clock with its own timer table. The drain only asks for now/setTimer/
// clearTimer, so the deadline can be exercised to the millisecond without real
// waiting; advancing the clock is synchronous and any promise continuations run on
// the next turn, which `tick()` gives them without depending on wall time.
function createFakeClock(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: current + Math.max(0, ms), callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    get pending() { return timers.size; },
    advance(ms) {
      const target = current + ms;
      // Fire due timers in order, moving the clock to each fire time first so a
      // callback that reads now() sees the moment it was scheduled for.
      for (;;) {
        let nextIdDue = null;
        let nextDue = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!nextDue || timer.at < nextDue.at)) { nextIdDue = id; nextDue = timer; }
        }
        if (!nextDue) break;
        timers.delete(nextIdDue);
        current = nextDue.at;
        nextDue.callback();
      }
      current = target;
    },
  };
}

// Let queued microtasks and promise continuations run without waiting on a real timer.
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('a drain that empties the queue stops after a single pass', async () => {
  const pending = { you: 1, them: 1 };
  let calls = 0;
  const outcome = await drainPendingAudio({
    channels: ['you', 'them'],
    flush: async (channel) => { calls += 1; pending[channel] = 0; },
    hasPending: (channel) => pending[channel] > 0,
  });
  assert.equal(calls, 2);
  assert.equal(outcome.passes, 1);
  assert.deepEqual(outcome.abandoned, []);
});

test('a provider that keeps rejecting the same audio cannot keep the drain spinning', async () => {
  // The regression: a persistent 429 re-requested the same chunks forever because
  // drain bypassed backoff and a failed flush preserved the retry queue.
  const pending = { you: 3, them: 3 };
  let calls = 0;
  const outcome = await drainPendingAudio({
    channels: ['you', 'them'],
    flush: async () => { calls += 1; },
    hasPending: (channel) => pending[channel] > 0,
    maxPasses: 3,
  });
  assert.equal(calls, 6, 'three passes per channel, then it gives up');
  assert.equal(outcome.passes, 3);
  assert.deepEqual(outcome.abandoned.sort(), ['them', 'you']);
});

test('a flush that throws is one failed pass, not a crashed drain', async () => {
  const outcome = await drainPendingAudio({
    channels: ['you'],
    flush: async () => { throw new Error('provider exploded'); },
    hasPending: () => true,
    maxPasses: 2,
  });
  assert.deepEqual(outcome.abandoned, ['you']);
  assert.equal(outcome.passes, 2);
});

test('a later pass that succeeds keeps the audio instead of abandoning it', async () => {
  let attempts = 0;
  const outcome = await drainPendingAudio({
    channels: ['you'],
    flush: async () => { attempts += 1; },
    hasPending: () => attempts < 2,
    maxPasses: 3,
  });
  assert.equal(attempts, 2);
  assert.equal(outcome.passes, 2);
  assert.deepEqual(outcome.abandoned, []);
  assert.deepEqual(outcome.results, [{ channel: 'you', passes: 2, completed: true }]);
});

test('one channel giving up does not stop the other from finishing', async () => {
  const pending = { you: true, them: true };
  const outcome = await drainPendingAudio({
    channels: ['you', 'them'],
    flush: async (channel) => { if (channel === 'them') pending.them = false; },
    hasPending: (channel) => pending[channel],
    maxPasses: 2,
  });
  assert.deepEqual(outcome.abandoned, ['you']);
  assert.deepEqual(outcome.results.find((result) => result.channel === 'them'), { channel: 'them', passes: 1, completed: true });
});

// The liveness defect these cover: the pass budget bounded attempts, not wall time,
// and each attempt awaited a transcription request whose client timeout is ten
// minutes. One hung socket could stall Stop for that long while still looking bounded.

test('a flush that never settles is abandoned once the deadline passes', async () => {
  const clock = createFakeClock();
  let calls = 0;
  let resolveLate;
  let settled = false;
  const drainPromise = drainPendingAudio({
    channels: ['you'],
    flush: () => { calls += 1; return new Promise((resolve) => { resolveLate = resolve; }); },
    hasPending: () => true,
    deadlineMs: 250,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  drainPromise.then(() => { settled = true; });
  await tick();
  assert.equal(clock.pending, 1, 'the pass arms exactly one deadline timer');

  clock.advance(249); // still inside the budget
  await tick();
  assert.equal(settled, false, 'a slow flush is still awaited while time remains');
  assert.equal(calls, 1);

  clock.advance(1); // deadline reached while the flush is still in flight
  const outcome = await drainPromise;
  assert.deepEqual(outcome.abandoned, ['you']);
  assert.equal(outcome.passes, 1);
  assert.equal(calls, 1, 'no new pass is started after the deadline');
  assert.equal(clock.pending, 0, 'the deadline timer is released, not left armed');

  // The abandoned flush finishing later must not change the reported outcome.
  resolveLate();
  await tick();
  assert.deepEqual(outcome.abandoned, ['you']);
});

test('a slow flush that finishes inside the deadline completes', async () => {
  const clock = createFakeClock();
  let resolveFlush;
  let pending = true;
  const drainPromise = drainPendingAudio({
    channels: ['you'],
    flush: () => new Promise((resolve) => { resolveFlush = resolve; }),
    hasPending: () => pending,
    deadlineMs: 500,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await tick();
  clock.advance(450); // slow, but still inside the budget
  await tick();
  pending = false;
  resolveFlush();
  const outcome = await drainPromise;
  assert.deepEqual(outcome.abandoned, [], 'finishing before the deadline is a success');
  assert.equal(outcome.passes, 1);
  assert.deepEqual(outcome.results, [{ channel: 'you', passes: 1, completed: true }]);
  assert.equal(clock.pending, 0, 'the deadline timer is cleared when the flush wins the race');
});

test('the deadline does not fire when the queues empty before it', async () => {
  const clock = createFakeClock();
  const pending = { you: 2, them: 2 };
  const outcome = await drainPendingAudio({
    channels: ['you', 'them'],
    flush: async (channel) => { pending[channel] = 0; },
    hasPending: (channel) => pending[channel] > 0,
    deadlineMs: 25,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  assert.deepEqual(outcome.abandoned, []);
  assert.equal(outcome.passes, 1);
  assert.equal(clock.pending, 0, 'a fast flush leaves no deadline timer behind');

  // Any timer that somehow outlived the drain is now late: firing it must be a no-op.
  clock.advance(10_000);
  await tick();
  assert.deepEqual(outcome.abandoned, []);
});

test('with maxPasses omitted a permanently failing flush stops after the default three passes', async () => {
  const pending = { you: 1, them: 1 };
  let calls = 0;
  const outcome = await drainPendingAudio({
    channels: ['you', 'them'],
    flush: async () => { calls += 1; throw new Error('provider still rejecting'); },
    hasPending: (channel) => pending[channel] > 0,
  });
  assert.equal(calls, 6, 'three failed passes per channel, not a fourth');
  assert.equal(outcome.passes, 3);
  assert.deepEqual(outcome.abandoned.sort(), ['them', 'you']);
});

test('a flush abandoned at the deadline cannot surface a late rejection', async () => {
  const clock = createFakeClock();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejectFlush;
    const drainPromise = drainPendingAudio({
      channels: ['you'],
      flush: () => new Promise((resolve, reject) => { rejectFlush = reject; }),
      hasPending: () => true,
      deadlineMs: 100,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await tick();
    clock.advance(100);
    const outcome = await drainPromise;
    assert.deepEqual(outcome.abandoned, ['you']);
    // The race already observed this promise, so its failure is not unhandled even
    // though the drain stopped waiting for it.
    rejectFlush(new Error('hung request finally failed'));
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the deadline defaults to ten seconds and Infinity opts out of it', async () => {
  assert.equal(DEFAULT_DEADLINE_MS, 10_000);
  const clock = createFakeClock();
  let calls = 0;
  const outcome = await drainPendingAudio({
    channels: ['you'],
    flush: async () => { calls += 1; if (calls > 1) throw new Error('still failing'); },
    hasPending: () => true,
    deadlineMs: Infinity,
    maxPasses: 2,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  assert.equal(calls, 2, 'no deadline is armed, so only the pass budget stops the loop');
  assert.deepEqual(outcome.abandoned, ['you']);
  assert.equal(clock.pending, 0, 'no timer is armed for an infinite deadline');
});
