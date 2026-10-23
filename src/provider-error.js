// Provider failures say very different things with the same status code. A bare
// 429 under load is a per-minute limit worth retrying; insufficient_quota on the
// same status means the account needs billing. Keeping those apart is the
// difference between "wait 38 seconds" and "top up your account".

function errorSignals(error) {
  const status = Number(error && (error.status || error.statusCode || (error.response && error.response.status)));
  const code = String((error && (error.code || (error.error && error.error.code))) || '').toLowerCase();
  const upstreamType = String((error && (error.error && error.error.type)) || '').toLowerCase();
  const rawMessage = String((error && error.message) || error || '');
  return { status, code, upstreamType, rawMessage, text: `${rawMessage} ${code} ${upstreamType}`.toLowerCase() };
}

function isQuotaError(error) {
  const { code, upstreamType, text } = errorSignals(error);
  if (code === 'insufficient_quota' || code === 'resource_exhausted') return true;
  if (upstreamType === 'insufficient_quota' || upstreamType === 'resource_exhausted') return true;
  if (code === 'rate_limit_exceeded' || upstreamType === 'rate_limit_error') return false;
  return /insufficient_quota|resource_exhausted|exceeded your current quota|\bquota\b|\bbilling\b/i.test(text);
}

function isRateLimitError(error) {
  if (isQuotaError(error)) return false;
  const { status, code, upstreamType, text } = errorSignals(error);
  return status === 429 || code === '429' || code === 'rate_limit_exceeded' || upstreamType === 'rate_limit_error' ||
    /\b429\b|too many requests|rate limit/i.test(text);
}

function isNotFoundError(error) {
  const { status, code, text } = errorSignals(error);
  return status === 404 || code === '404' || /model.*not found|unknown model|deployment.*not found|is not found for api version/i.test(text);
}

// Gemini puts a google.rpc.RetryInfo detail such as {"retryDelay":"38s"} inside
// the error body. OpenAI and Anthropic do not, so this is best effort and
// returns null rather than guessing.
function extractRetryDelaySeconds(rawMessage) {
  const match = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(rawMessage || ''));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function formatRetryWait(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function waitHint(error) {
  const seconds = extractRetryDelaySeconds(errorSignals(error).rawMessage);
  const wait = formatRetryWait(seconds);
  return wait ? ` Wait about ${wait}, then try again.` : ' Wait a moment, then try again.';
}

function sanitizeProviderError(error, { timedOut = false, providerLabel = '' } = {}) {
  if (timedOut) return 'The AI request timed out. Try again or use fewer screenshots.';
  if (error && error.name === 'AbortError') return 'The AI request was canceled.';

  const label = providerLabel || 'The response provider';
  const { status, code, text } = errorSignals(error);

  if (status === 401 || status === 403 || /auth|api.?key|permission|unauthorized|forbidden/.test(`${code} ${text}`)) {
    return 'The response provider rejected the credentials or model access. Check the provider key and selected model.';
  }
  if (isQuotaError(error)) {
    return `${label} quota is exhausted (429 Too Many Requests). Top up or add billing to that account, or switch provider or model in Settings.`;
  }
  if (isRateLimitError(error)) {
    return `${label} is rate-limiting requests (429 Too Many Requests).${waitHint(error)} This is a temporary per-minute limit, not an empty balance.`;
  }
  if (isNotFoundError(error)) {
    return 'The selected model or deployment is unavailable. Check the model name in Settings.';
  }
  if (status === 413 || /too large|request.?size|context.?length|too many.*image|max.*token/.test(`${code} ${text}`)) {
    return 'The AI request was too large. Clear some Task Context screens or use less conversation context.';
  }
  if (/at most \d+ image/.test(`${code} ${text}`)) {
    return 'This provider accepts fewer screens per request than Task Context captured. Use fewer saved screens or choose a provider that accepts multiple images.';
  }
  if (/timeout|timed out|etimedout/.test(`${code} ${text}`)) {
    return 'The response provider timed out. Check the network and try again.';
  }
  if (/network|fetch failed|econnreset|enotfound|eai_again|socket/.test(`${code} ${text}`)) {
    return 'The response provider could not be reached. Check the network and try again.';
  }
  return 'The response provider failed before completing the answer. Check Settings or try another provider.';
}

module.exports = {
  sanitizeProviderError,
  errorSignals,
  isQuotaError,
  isRateLimitError,
  isNotFoundError,
  extractRetryDelaySeconds,
  formatRetryWait,
};
