const PROVIDERS = Object.freeze({
  openai: {
    label: 'OpenAI',
    models: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    supportsVision: true,
  },
  anthropic: {
    label: 'Anthropic',
    models: { fast: 'claude-haiku-4-5', smart: 'claude-sonnet-5' },
    supportsVision: true,
  },
  gemini: {
    label: 'Gemini',
    models: { fast: 'gemini-3.5-flash', smart: 'gemini-2.5-pro' },
    supportsVision: true,
  },
  azure: {
    label: 'Azure Foundry',
    models: { fast: '', smart: '' },
    supportsVision: true,
    tokenLimitParameter: 'max_completion_tokens',
  },
  deepseek: {
    label: 'DeepSeek',
    models: { fast: 'deepseek-v4-flash', smart: 'deepseek-v4-pro' },
    supportsVision: false,
    baseURL: 'https://api.deepseek.com',
  },
});

function getDefaultSettings() {
  const apiKeys = {};
  const models = {};
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    apiKeys[id] = '';
    models[id] = { ...provider.models };
  }

  return {
    provider: 'openai',
    fallbackProvider: '',
    smart: false,
    questionDetection: true,
    assistContext: 'both',
    apiKeys: { ...apiKeys, deepgram: '', azureRealtime: '' },
    models,
    endpoints: { azure: '', azureRealtime: '' },
    audio: {
      inputDeviceId: '',
      micEnabled: true,
      systemEnabled: true,
      browserMicProcessing: true,
      sensitivity: 'balanced',
      silenceMs: 700,
      preRollMs: 250,
      costWarningMinutes: 30,
      maxSessionMinutes: 60,
    },
    transcription: {
      mode: 'realtime',
      realtimeProvider: 'openai',
      realtimeModel: 'gpt-realtime-whisper',
      deepgramModel: 'nova-3',
      azureRealtimeDeployment: '',
      fallbackModel: 'gpt-4o-mini-transcribe',
      geminiFallbackModel: 'gemini-3.5-flash',
      offlineEnabled: false,
      offlineCloudFallback: false,
      language: '',
      delay: 'low',
    },
  };
}

function normalizeAzureEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Azure Foundry endpoint must be a valid URL.');
  }

  const host = url.hostname.toLowerCase();
  const officialHost = host.endsWith('.services.ai.azure.com') || host.endsWith('.openai.azure.com');
  let path = url.pathname.replace(/\/+$/, '');
  if (!path) path = '/openai/v1';
  const resourceRoute = path === '/openai/v1';
  const projectRoute = host.endsWith('.services.ai.azure.com')
    && /^\/api\/projects\/[^/]+\/openai\/v1$/.test(path);
  if (
    url.protocol !== 'https:' ||
    !officialHost ||
    (!resourceRoute && !projectRoute) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('Azure Foundry endpoint must be an official resource or project-scoped HTTPS /openai/v1 endpoint.');
  }

  return `https://${host}${path}`;
}

function normalizeTranscriptionLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  return ['auto', 'automatic'].includes(language) ? '' : language;
}

function resolveProvider(settings) {
  const provider = settings.provider;
  const definition = PROVIDERS[provider];
  if (!definition) {
    return {
      provider,
      ready: false,
      configurationError: `Unknown provider: ${provider}`,
      supportsVision: false,
    };
  }

  const apiKey = (settings.apiKeys || {})[provider] || '';
  const tier = settings.smart ? 'smart' : 'fast';
  const model = ((settings.models || {})[provider] || {})[tier] || '';
  let baseURL = definition.baseURL || null;
  let configurationError = null;

  if (provider === 'azure') {
    try {
      baseURL = normalizeAzureEndpoint(((settings.endpoints || {}).azure || ''));
    } catch (error) {
      configurationError = error.message;
    }
  }

  if (!apiKey) configurationError = `${definition.label} API key is required.`;
  else if (!model) configurationError = `${definition.label} ${tier} model or deployment name is required.`;

  return {
    provider,
    label: definition.label,
    apiKey,
    model,
    tier,
    baseURL,
    supportsVision: definition.supportsVision,
    tokenLimitParameter: definition.tokenLimitParameter || 'max_tokens',
    configurationError,
    ready: !configurationError,
  };
}

function resolveRealtimeTranscription(settings) {
  const transcription = settings.transcription || {};
  const provider = transcription.realtimeProvider || 'openai';
  const isAzure = provider === 'azure';
  const isDeepgram = provider === 'deepgram';
  const label = isAzure ? 'Azure Foundry' : (isDeepgram ? 'Deepgram' : 'OpenAI');
  const keys = settings.apiKeys || {};
  const endpoints = settings.endpoints || {};
  const apiKey = String(isAzure ? (keys.azureRealtime || keys.azure || '') : (keys[provider] || '')).trim();
  const model = String(isAzure
    ? (transcription.azureRealtimeDeployment || '')
    : (isDeepgram ? (transcription.deepgramModel || 'nova-3') : (transcription.realtimeModel || 'gpt-realtime-whisper'))).trim();
  let endpoint = null;
  let configurationError = null;

  if (!['openai', 'azure', 'deepgram'].includes(provider)) {
    configurationError = `Unsupported realtime transcription provider: ${provider}`;
  } else if (isAzure) {
    try { endpoint = normalizeAzureEndpoint((endpoints.azureRealtime || endpoints.azure || '')); }
    catch (error) { configurationError = error.message; }
  }

  if (!apiKey) configurationError = `${label} API key is required for realtime transcription.`;
  else if (!model) configurationError = `${label} realtime deployment or model name is required.`;

  return {
    provider,
    label,
    apiKey,
    endpoint,
    model,
    ready: !configurationError,
    configurationError,
  };
}

module.exports = {
  PROVIDERS,
  getDefaultSettings,
  normalizeAzureEndpoint,
  normalizeTranscriptionLanguage,
  resolveProvider,
  resolveRealtimeTranscription,
};
