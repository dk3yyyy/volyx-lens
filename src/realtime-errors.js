'use strict';

// Unified classifier for realtime transcription failures. OpenAI, Azure, and
// Deepgram channels all funnel through here so error codes stay consistent
// across providers. Raw error code/type/message text is mapped to a stable
// error object carrying code, message, and channel; provider-specific wording
// and the Deepgram rate-limit check are supplied as options.
function classifyRealtimeError(error, channel, {
  providerLabel = 'Realtime transcription',
  includeRateLimit = false,
} = {}) {
  const candidate = [error && error.code, error && error.type, error && error.message]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');
  // Rate limits must be checked before the generic auth branch: a 429 payload
  // often mentions the credential that was throttled ("Rate limit exceeded for
  // token abc"), and must not be reported as an authentication failure.
  if (includeRateLimit && /(429|rate.?limit|too many requests)/.test(candidate)) {
    return { code: 'realtime_rate_limited', message: `${providerLabel} rate limit was reached.`, channel };
  }
  if (/(auth|token|api.?key|401|403)/.test(candidate)) {
    return { code: 'realtime_authentication_failed', message: `${providerLabel} authentication failed.`, channel };
  }
  if (candidate.includes('timeout')) {
    return { code: 'realtime_connection_timeout', message: `${providerLabel} connection timed out.`, channel };
  }
  if (/(network|socket|transport|connect|closed|backpressure|ws_)/.test(candidate)) {
    return { code: 'realtime_transport_failed', message: `${providerLabel} connection failed.`, channel };
  }
  if (/(audio|transcription)/.test(candidate)) {
    return { code: 'realtime_audio_failed', message: `${providerLabel} could not process this audio segment.`, channel };
  }
  return { code: 'realtime_failed', message: `${providerLabel} failed.`, channel };
}

module.exports = { classifyRealtimeError };
