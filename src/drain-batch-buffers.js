'use strict';

// Draining on Stop is best-effort: whatever speech is still buffered gets one more
// chance at transcription. A provider that keeps rejecting that audio must not hold
// the capture state machine hostage. The previous loop re-requested the same chunks
// without bound, because a drain deliberately bypasses backoff and a failed flush
// preserves the retry queue — so one persistent 429 during Stop never settled.
// The pass budget bounds the work; the caller decides what happens to what is left.
//
// A pass budget alone still is not a liveness bound. Each pass awaits a flush that
// ultimately awaits a transcription request, and the STT client's own timeout is ten
// minutes. One hung socket would therefore hold this drain — and the serialized state
// transition awaiting it — for ten minutes while looking "bounded" by maxPasses. So
// the loop also carries a wall-clock deadline: it never starts a pass after the
// deadline, and it never waits past the deadline for a flush that does not settle.
// Giving up on the wait does not cancel the request (the module does not own the
// socket); it only stops this drain from being blocked by it. Channels still pending
// at that point are reported abandoned exactly as a pass-budget exhaustion is, so the
// caller drops and messages them the same way.

const DEFAULT_MAX_PASSES = 3;

// Ten seconds is generous for a best-effort drain of a few chunks on Stop, and short
// enough that a hung request cannot make Stop look dead. Callers that genuinely need
// a different budget can pass their own, or Infinity to opt out of the deadline.
const DEFAULT_DEADLINE_MS = 10000;

// Sentinel for "the timer won the race". Distinguishable from any value a flush could
// resolve with, including undefined.
const DEADLINE_REACHED = Symbol('drain deadline reached');

// Run one flush against the remaining wall time. Resolves with
// { timedOut: boolean }; a rejected flush still rejects, so the caller counts it as a
// failed pass. The timer is always cleared on the way out: whether the flush settled
// or the deadline won, no timer is left armed behind a pass.
async function flushWithinDeadline(flush, channel, remainingMs, { setTimer, clearTimer }) {
  // Without a finite budget (deadlineMs: Infinity) there is nothing to race against,
  // and arming a timer with Infinity would be a bug: host timers overflow it to 1ms.
  if (!Number.isFinite(remainingMs)) {
    await flush(channel, { drain: true });
    return { timedOut: false };
  }

  let timer = null;
  // Armed before the flush starts, and before any await: the deadline must not depend
  // on the request it is bounding getting as far as its own first suspension. Both the
  // arming and the call below are synchronous, so they are adjacent in pass time.
  const deadline = new Promise((resolve) => {
    timer = setTimer(() => resolve(DEADLINE_REACHED), Math.max(0, remainingMs));
  });

  try {
    const outcome = await Promise.race([
      // Wrapped so a flush that throws synchronously becomes a rejection the race can
      // observe, instead of escaping before the timer is cleared. The race subscribes
      // to this promise even when it loses, so a flush that rejects after the deadline
      // cannot surface as an unhandled rejection.
      (async () => flush(channel, { drain: true }))(),
      deadline,
    ]);
    return { timedOut: outcome === DEADLINE_REACHED };
  } finally {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }
}

async function drainPendingAudio({
  channels = [],
  flush,
  hasPending,
  maxPasses = DEFAULT_MAX_PASSES,
  deadlineMs = DEFAULT_DEADLINE_MS,
  // Time is injected so this liveness bound is testable without real waiting. The
  // defaults are the host's own clock and timers, so Electron main needs no changes.
  now = () => Date.now(),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  const startedAt = now();
  // The deadline is per drain call and shared by all channels: the caller awaits one
  // serialized transition, so a per-channel budget would multiply the worst case.
  const deadlineAt = Number.isFinite(deadlineMs) ? startedAt + Math.max(0, deadlineMs) : Infinity;

  const results = await Promise.all(channels.map(async (channel) => {
    let passes = 0;
    let outOfTime = false;
    while (passes < maxPasses && !outOfTime) {
      const remaining = deadlineAt - now();
      // Checked before every pass, not only once at entry: a provider that ate the
      // whole budget must not be handed another attempt just because it failed fast.
      if (!(remaining > 0)) {
        outOfTime = true;
        break;
      }
      passes += 1;
      try {
        const { timedOut } = await flushWithinDeadline(flush, channel, remaining, { setTimer, clearTimer });
        // A pass that ran out of time is a failed pass: fall through to the same
        // pending check as a rejected flush, then stop starting passes.
        if (timedOut) outOfTime = true;
      } catch {
        // A rejected flush is one more failed pass, not a reason to drop the other
        // channel's audio or to stop draining early.
      }
      if (!hasPending(channel)) return { channel, passes, completed: true };
    }
    return { channel, passes, completed: false };
  }));

  return {
    results,
    passes: results.reduce((highest, result) => Math.max(highest, result.passes), 0),
    abandoned: results.filter((result) => !result.completed).map((result) => result.channel),
  };
}

module.exports = { drainPendingAudio, DEFAULT_MAX_PASSES, DEFAULT_DEADLINE_MS };
