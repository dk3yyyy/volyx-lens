'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { drainPendingAudio } = require('../src/drain-batch-buffers');

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
