'use strict';

// Draining on Stop is best-effort: whatever speech is still buffered gets one more
// chance at transcription. A provider that keeps rejecting that audio must not hold
// the capture state machine hostage. The previous loop re-requested the same chunks
// without bound, because a drain deliberately bypasses backoff and a failed flush
// preserves the retry queue — so one persistent 429 during Stop never settled.
// The pass budget bounds the work; the caller decides what happens to what is left.

const DEFAULT_MAX_PASSES = 3;

async function drainPendingAudio({ channels = [], flush, hasPending, maxPasses = DEFAULT_MAX_PASSES } = {}) {
  const results = await Promise.all(channels.map(async (channel) => {
    let passes = 0;
    while (passes < maxPasses) {
      passes += 1;
      try {
        await flush(channel, { drain: true });
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

module.exports = { drainPendingAudio, DEFAULT_MAX_PASSES };
