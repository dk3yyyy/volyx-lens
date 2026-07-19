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
  return { llm: route.primary, fallback: null, usedFallback: false, reason: '' };
}

async function streamWithFallback({ llm, fallback, params, onFallback = () => {} }) {
  let emitted = false;
  const onToken = params.onToken || (() => {});
  const primaryParams = {
    ...params,
    onToken(token) {
      emitted = true;
      onToken(token);
    },
  };
  try {
    return await llm.stream(primaryParams);
  } catch (error) {
    if (params.signal && params.signal.aborted) throw error;
    const hasImages = Boolean(params.imageDataUrl) || (Array.isArray(params.imageDataUrls) && params.imageDataUrls.length > 0);
    const compatible = fallback && fallback.ready && (!hasImages || fallback.supportsVision);
    if (emitted || !compatible) throw error;
    onFallback({ error, from: llm, to: fallback });
    return fallback.stream({ ...params, onToken });
  }
}

module.exports = { createResponseRoute, chooseInitialProvider, streamWithFallback };
