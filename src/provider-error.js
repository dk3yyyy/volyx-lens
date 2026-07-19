function sanitizeProviderError(error, { timedOut = false } = {}) {
  if (timedOut) return 'The AI request timed out. Try again or use fewer screenshots.';
  const status = Number(error && error.status);
  const code = String((error && error.code) || '').toLowerCase();
  const message = String((error && error.message) || '').toLowerCase();

  if (error && error.name === 'AbortError') return 'The AI request was canceled.';
  if (status === 401 || status === 403 || /auth|api.?key|permission|unauthorized|forbidden/.test(`${code} ${message}`)) {
    return 'The response provider rejected the credentials or model access. Check the provider key and selected model.';
  }
  if (status === 429 || /rate.?limit|quota/.test(`${code} ${message}`)) {
    return 'The response provider rate limit or quota was exceeded. Wait briefly or choose another provider.';
  }
  if (status === 413 || /too large|request.?size|context.?length|too many.*image|max.*token/.test(`${code} ${message}`)) {
    return 'The AI request was too large. Clear some Task Context screens or use less conversation context.';
  }
  if (status === 404 || /model.*not found|unknown model|deployment.*not found/.test(`${code} ${message}`)) {
    return 'The selected model or deployment is unavailable. Check the model name in Settings.';
  }
  if (/timeout|timed out|etimedout/.test(`${code} ${message}`)) {
    return 'The response provider timed out. Check the network and try again.';
  }
  if (/network|fetch failed|econnreset|enotfound|eai_again|socket/.test(`${code} ${message}`)) {
    return 'The response provider could not be reached. Check the network and try again.';
  }
  return 'The response provider failed before completing the answer. Check Settings or try another provider.';
}

module.exports = { sanitizeProviderError };
