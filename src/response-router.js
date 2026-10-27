const { createLLM } = require('./llm');

function createResponseRoute(settings, factory = createLLM) {
  const primary = factory({ ...settings, provider: settings.provider });
  const fallbackId = settings.fallbackProvider && settings.fallbackProvider !== settings.provider
    ? settings.fallbackProvider
    : '';
  const fallback = fallbackId ? factory({ ...settings, provider: fallbackId }) : null;
  return { primary, fallback };
}

function chooseInitialProvider(route, { requiresVision = false } = {}) {
  const primaryCompatible = route.primary.ready && (!requiresVision || route.primary.supportsVision);
  const fallbackCompatible = route.fallback && route.fallback.ready && (!requiresVision || route.fallback.supportsVision);
  if (primaryCompatible) return { llm: route.primary, fallback: fallbackCompatible ? route.fallback : null, usedFallback: false, reason: '' };
  if (fallbackCompatible) {
    return {
      llm: route.fallback,
      fallback: null,
      usedFallback: true,
      reason: route.primary.ready ? 'The default provider cannot satisfy this request.' : route.primary.configurationError,
    };
  }
  const reason = requiresVision
    ? 'No vision-capable provider is configured.'
    : 'No compatible provider is configured.';
  return { llm: null, fallback: null, usedFallback: false, reason };
}

// Provider failures mean different things. A rejected key will reject every part of
// a long job, a rate limit is worth retrying, and a timeout should move on to the
// fallback with a fresh clock.
function classifyProviderError(error) {
  const status = Number(
    (error && (error.status || error.statusCode))
    || (error && error.response && error.response.status)
    || 0,
  );
  const text = `${(error && (error.code || '')) || ''} ${(error && error.message) || ''}`;
  if (status === 401 || status === 403 || /auth|api.?key|permission|unauthorized|forbidden/i.test(text)) return 'auth';
  if (status === 429 || /rate.?limit|quota/i.test(text)) return 'rate-limit';
  if (status >= 400 && status < 500) return 'invalid-request';
  if (/timed? ?out|etimedout|aborted/i.test(text)) return 'timeout';
  return 'unknown';
}

async function streamWithFallback({
  llm,
  fallback,
  params,
  onFallback = () => {},
  perAttemptTimeoutMs = 0,
}) {
  let emitted = false;
  const onToken = params.onToken || (() => {});
  const outer = params.signal || null;

  // Each attempt gets its own controller and, when asked for, its own deadline.
  // One shared deadline across a chunked job meant a long meeting ran out of time
  // with most of its parts already summarized (VR-07), and an expired deadline was
  // indistinguishable from a user cancel, so the fallback never ran (VR-06).
  const runAttempt = async (target) => {
    const controller = new AbortController();
    let attempt = { timedOut: false };
    let timer = null;
    const cancel = (reason) => {
      if (controller.signal.aborted) return;
      attempt.timedOut = reason === 'timeout';
      controller.abort(reason);
    };
    const onOuterAbort = () => cancel(outer && outer.reason === 'timeout' ? 'timeout' : 'cancel');
    if (outer) {
      if (outer.aborted) onOuterAbort();
      else outer.addEventListener('abort', onOuterAbort, { once: true });
    }
    if (perAttemptTimeoutMs > 0) {
      // Deliberately not unref'd: an unref'd deadline does not fire when nothing else
      // is holding the loop open, which is exactly the hung-request case it exists
      // for. CI caught that; a provider that never answers must still time out.
      timer = setTimeout(() => cancel('timeout'), perAttemptTimeoutMs);
    }
    try {
      return await target.stream({
        ...params,
        signal: controller.signal,
        onToken(token) {
          emitted = true;
          onToken(token);
        },
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.timedOut = attempt.timedOut;
      failure.canceled = Boolean(controller.signal.aborted) && !attempt.timedOut;
      throw failure;
    } finally {
      if (timer) clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    }
  };

  try {
    return await runAttempt(llm);
  } catch (error) {
    // A user cancel stays a cancel. A deadline that expired is not a cancel: the
    // fallback deserves its own attempt with its own clock.
    if (error && error.canceled) throw error;
    const hasImages = Boolean(params.imageDataUrl) || (Array.isArray(params.imageDataUrls) && params.imageDataUrls.length > 0);
    const compatible = fallback && fallback.ready && (!hasImages || fallback.supportsVision);
    if (emitted || !compatible) throw error;
    const reason = error && error.timedOut ? 'timeout' : classifyProviderError(error);
    onFallback({ error, from: llm, to: fallback, reason });
    return runAttempt(fallback);
  }
}

module.exports = { createResponseRoute, chooseInitialProvider, streamWithFallback, classifyProviderError };
