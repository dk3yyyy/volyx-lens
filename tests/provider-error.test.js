const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeProviderError } = require('../src/provider-error');

test('provider errors are actionable without exposing raw secrets or endpoints', () => {
  const secret = ['sk', 'private', 'value'].join('-');
  const cases = [
    [Object.assign(new Error(`Unauthorized ${secret}`), { status: 401 }), /credentials or model access/i],
    [Object.assign(new Error('quota exhausted'), { status: 429 }), /rate limit or quota/i],
    [Object.assign(new Error('context length exceeded'), { status: 413 }), /too large/i],
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
