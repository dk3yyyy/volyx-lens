'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyRealtimeError } = require('../src/realtime-errors');

const classifyForDeepgram = (message) =>
  classifyRealtimeError({ message }, 'mic', {
    providerLabel: 'Deepgram transcription',
    includeRateLimit: true,
  });

test('rate limits win over the generic token match', () => {
  // Deepgram 429 payloads name the throttled credential, so "token" alone must
  // not reclassify them as authentication failures.
  assert.equal(classifyForDeepgram('Rate limit exceeded for token abc').code, 'realtime_rate_limited');
  assert.equal(classifyForDeepgram('Too Many Requests').code, 'realtime_rate_limited');
  assert.equal(classifyForDeepgram('429').code, 'realtime_rate_limited');
});

test('genuine credential failures stay authentication failures', () => {
  assert.equal(classifyForDeepgram('401 invalid token').code, 'realtime_authentication_failed');
  assert.equal(classifyForDeepgram('invalid api key').code, 'realtime_authentication_failed');
});

test('transport and audio failures keep their own categories', () => {
  assert.equal(classifyForDeepgram('socket closed').code, 'realtime_transport_failed');
  assert.equal(classifyForDeepgram('audio decode failed').code, 'realtime_audio_failed');
});
