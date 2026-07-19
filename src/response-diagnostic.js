const { PROVIDERS } = require('./provider-config');
const { createLLM: defaultCreateLLM } = require('./llm');
const { sanitizeProviderError } = require('./provider-error');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_OUTPUT_TOKENS = 64;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function azureRouteKind(baseURL) {
  try {
    const url = new URL(baseURL);
    if (/^\/api\/projects\/[^/]+\/openai\/v1$/.test(url.pathname)) return 'project';
    if (url.hostname.endsWith('.openai.azure.com')) return 'azure-openai-resource';
    return 'foundry-resource';
  } catch {
    return 'invalid';
  }
}

function diagnosticMessage(error, { provider, model, route, timedOut }) {
  if (timedOut) return 'The provider did not respond within 15 seconds.';
  const status = Number(error && error.status);
  const text = String((error && error.message) || '').toLowerCase();

  if (provider === 'azure') {
    if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|api.?key|authentication/.test(text)) {
      return 'Azure rejected the saved credential. Confirm the key belongs to the configured resource or project endpoint.';
    }
    if (status === 404 || /deployment.*not found|model.*not found|resource not found/.test(text)) {
      const routeLabel = route === 'project' ? 'project-scoped' : 'resource-level';
      return `Azure could not find deployment "${model}" at the configured ${routeLabel} endpoint. Confirm that the endpoint and key belong to the deployment's resource or project.`;
    }
  }

  return sanitizeProviderError(error, { timedOut: false });
}

async function runResponseDiagnostic({
  settings,
  provider,
  tier,
  createLLM = defaultCreateLLM,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  const normalizedProvider = String(provider || '');
  const normalizedTier = tier === 'smart' ? 'smart' : 'fast';
  if (!Object.hasOwn(PROVIDERS, normalizedProvider)) {
    return { ok: false, code: 'unknown_provider', message: 'Choose a supported response provider.' };
  }

  const diagnosticSettings = clone(settings || {});
  diagnosticSettings.provider = normalizedProvider;
  diagnosticSettings.fallbackProvider = '';
  diagnosticSettings.smart = normalizedTier === 'smart';
  const llm = createLLM(diagnosticSettings);
  const route = normalizedProvider === 'azure' ? azureRouteKind(llm.baseURL) : 'provider-api';
  const base = {
    provider: normalizedProvider,
    label: llm.label || PROVIDERS[normalizedProvider].label,
    tier: normalizedTier,
    model: llm.model || '',
    supportsVision: llm.supportsVision === true,
    route,
  };

  if (!llm.ready) {
    return { ...base, ok: false, code: 'configuration', latencyMs: 0, message: llm.configurationError || 'The provider configuration is incomplete.' };
  }

  const controller = new AbortController();
  let timedOut = false;
  const startedAt = now();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    await llm.stream({
      system: 'This is a connection diagnostic. Follow the user instruction exactly.',
      turns: [{ role: 'user', text: 'Reply with exactly OK.' }],
      imageDataUrl: null,
      imageDataUrls: [],
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: controller.signal,
      onToken() {},
    });
    return {
      ...base,
      ok: true,
      code: 'connected',
      latencyMs: Math.max(0, now() - startedAt),
      message: `${base.label} accepted a minimal text-only request using the ${normalizedTier} model.`,
    };
  } catch (error) {
    const latencyMs = Math.max(0, now() - startedAt);
    return {
      ...base,
      ok: false,
      code: timedOut ? 'timeout' : (Number(error && error.status) ? `http_${Number(error.status)}` : 'request_failed'),
      latencyMs,
      message: diagnosticMessage(error, { provider: normalizedProvider, model: base.model, route, timedOut }),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  azureRouteKind,
  diagnosticMessage,
  runResponseDiagnostic,
};
