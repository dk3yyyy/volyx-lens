const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeProviderError,
  isQuotaError,
  isRateLimitError,
  extractRetryDelaySeconds,
} = require('../src/provider-error');

test('provider errors are actionable without exposing raw secrets or endpoints', () => {
  const secret = ['sk', 'private', 'value'].join('-');
  const cases = [
    [Object.assign(new Error(`Unauthorized ${secret}`), { status: 401 }), /credentials or model access/i],
    [Object.assign(new Error('context length exceeded'), { status: 413 }), /too large/i],
    [Object.assign(new Error('At most 1 image(s) may be provided in one prompt'), { status: 400 }), /accepts fewer screens/i],
    [Object.assign(new Error('deployment not found'), { status: 404 }), /model or deployment/i],
    [new Error('fetch failed ECONNRESET https://private.example'), /could not be reached/i],
  ];
  for (const [error, expected] of cases) {
    const sanitized = sanitizeProviderError(error);
    assert.match(sanitized, expected);
    assert.doesNotMatch(sanitized, new RegExp(secret));
    assert.doesNotMatch(sanitized, /private\.example/);
  }
  assert.match(sanitizeProviderError(new Error('anything'), { timedOut: true }), /timed out/i);
});

test('an empty account is reported as quota, not as a temporary rate limit', () => {
  const quota = Object.assign(new Error('You exceeded your current quota'), { status: 429, code: 'insufficient_quota' });
  const message = sanitizeProviderError(quota, { providerLabel: 'OpenAI' });

  assert.equal(isQuotaError(quota), true);
  assert.equal(isRateLimitError(quota), false);
  assert.match(message, /OpenAI quota is exhausted/i);
  assert.match(message, /billing/i);
  assert.doesNotMatch(message, /temporary per-minute limit/i);
});

test('a burst limit is reported as retryable and keeps Gemini retryDelay', () => {
  const burst = Object.assign(new Error('{"error":{"code":429,"retryDelay":"38s"}}'), { status: 429 });
  const message = sanitizeProviderError(burst, { providerLabel: 'Gemini' });

  assert.equal(isRateLimitError(burst), true);
  assert.equal(isQuotaError(burst), false);
  assert.equal(extractRetryDelaySeconds(burst.message), 38);
  assert.match(message, /Gemini is rate-limiting requests/i);
  assert.match(message, /Wait about 38 seconds/i);
  assert.match(message, /not an empty balance/i);
});

test('anthropic rate limit envelopes are not mistaken for quota exhaustion', () => {
  const error = Object.assign(new Error('rate limited'), { status: 429, error: { type: 'rate_limit_error' } });
  const message = sanitizeProviderError(error, { providerLabel: 'Anthropic' });

  assert.equal(isQuotaError(error), false);
  assert.equal(isRateLimitError(error), true);
  assert.match(message, /rate-limiting requests/i);
});

test('a bare 429 with no body still reads as a rate limit', () => {
  const error = Object.assign(new Error(''), { status: 429 });
  assert.match(sanitizeProviderError(error), /rate-limiting requests/i);
  assert.match(sanitizeProviderError(error), /Wait a moment/i);
});
