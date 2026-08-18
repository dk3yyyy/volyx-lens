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
  groq: {
    label: 'Groq',
    models: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    supportsVision: false,
    baseURL: 'https://api.groq.com/openai/v1',
  },
  nvidia: {
    label: 'NVIDIA',
    models: { fast: 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1', smart: 'meta/llama-3.2-11b-vision-instruct' },
    supportsVision: true,
    baseURL: 'https://integrate.api.nvidia.com/v1',
    // The NVIDIA hosted API accepts at most one image per prompt. Task Context
    // image selection must be capped to one screen so multi-screen requests
    // are not rejected after capture.
    maxImagesPerRequest: 1,
  },
  openrouter: {
    label: 'OpenRouter',
    models: { fast: 'meta-llama/llama-3.1-8b-instruct', smart: 'openai/gpt-4o' },
    supportsVision: true,
    baseURL: 'https://openrouter.ai/api/v1',
  },
  ollama: {
    label: 'Ollama',
    models: { fast: 'llama3.2', smart: 'llama3.3' },
    supportsVision: true,
    requiresKey: false,
    baseURL: 'http://localhost:11434/v1',
  },
});

// Single source of truth for speech-to-text model defaults shared by the
// transcription pipeline (realtime-stt, deepgram-realtime, stt) and Settings.
const STT_MODELS = Object.freeze({
  realtime: 'gpt-realtime-whisper',
  deepgram: 'nova-3',
  openaiFallback: 'gpt-4o-mini-transcribe',
  geminiFallback: 'gemini-3.5-flash',
});

// Azure AI Speech is configured with a region (its Speech resource has no
// deployment name), so a dedicated key slot keeps it independent of the Azure
// Foundry / Azure Realtime credentials used by the OpenAI-compatible paths.
const REALTIME_PROVIDERS = Object.freeze(['openai', 'azure', 'deepgram', 'azureSpeech']);

// OpenAI-compatible providers where the fast and smart tiers may use different
// APIs. These get optional per-tier API key slots (provider.fast / provider.smart)
// and per-tier endpoint overrides in Settings.
const TIER_KEY_PROVIDERS = Object.freeze(['azure', 'deepseek', 'groq', 'nvidia', 'openrouter']);

function getDefaultSettings() {
  const apiKeys = {};
  const models = {};
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    apiKeys[id] = '';
    models[id] = { ...provider.models };
    if (TIER_KEY_PROVIDERS.includes(id)) {
      apiKeys[`${id}.fast`] = '';
      apiKeys[`${id}.smart`] = '';
    }
  }

  return {
    provider: 'openai',
    fallbackProvider: '',
    smart: false,
    questionDetection: true,
    autoAnswer: false,
    autoAnswerConfidence: 0.5,
    autoAnswerCooldownSec: 60,
    assistContext: 'both',
    apiKeys: { ...apiKeys, deepgram: '', azureRealtime: '', azureSpeech: '' },
    models,
    endpoints: { azure: '', azureRealtime: '' },
    endpointByTier: {},
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
      realtimeModel: STT_MODELS.realtime,
      deepgramModel: STT_MODELS.deepgram,
      azureRealtimeDeployment: '',
      azureSpeechRegion: '',
      azureSpeechPhrases: '',
      fallbackModel: STT_MODELS.openaiFallback,
      geminiFallbackModel: STT_MODELS.geminiFallback,
      offlineEnabled: false,
      offlineCloudFallback: false,
      language: '',
      delay: 'low',
      whisperModel: 'base.en',
      historyEnabled: false,
      meetingDetection: false,
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

// A Speech resource region is a short lowercase identifier (e.g. eastus,
// westeurope). It builds the wss://<region>.stt.speech.microsoft.com host, so
// it must be a bare region, not a URL.
function normalizeAzureSpeechRegion(value) {
  const region = String(value || '').trim().toLowerCase();
  if (!region) return '';
  if (/^[a-z0-9][a-z0-9-]{1,62}$/.test(region)) return region;
  throw new Error('Azure AI Speech region must be a bare region name (e.g. "eastus"), not a URL.');
}

// The phrase list is an optional comma- or newline-separated string of words
// Azure AI Speech should prioritize recognizing (product names, names, jargon).
function normalizePhraseList(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .slice(0, 50);
}

// A provider may expose different base URLs per tier (e.g. a fast model on one
// API and a smart model on another). Settings can override either tier with a
// custom endpoint; otherwise the tier-specific default or the shared baseURL
// is used. Azure endpoints always pass through official-endpoint validation.
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

  const tier = settings.smart ? 'smart' : 'fast';
  const apiKey = ((settings.apiKeys || {})[`${provider}.${tier}`] || (settings.apiKeys || {})[provider] || '').trim();
  const model = ((settings.models || {})[provider] || {})[tier] || '';
  const requiresKey = definition.requiresKey !== false;
  const tierOverrides = (settings.endpointByTier || {})[provider] || {};
  const tierEndpoint = String(tierOverrides[tier] || '').trim();
  let baseURL = null;
  let configurationError = null;

  if (provider === 'azure') {
    try {
      baseURL = normalizeAzureEndpoint(tierEndpoint || ((settings.endpoints || {}).azure || ''));
    } catch (error) {
      configurationError = error.message;
    }
  } else if (tierEndpoint) {
    try {
      const url = new URL(tierEndpoint);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
      baseURL = tierEndpoint.replace(/\/+$/, '');
    } catch {
      configurationError = `${definition.label} ${tier} endpoint must be a valid http(s) URL.`;
    }
  } else {
    baseURL = (definition.baseURLByTier && definition.baseURLByTier[tier]) || definition.baseURL || null;
  }

  if (requiresKey && !apiKey) configurationError = `${definition.label} API key is required.`;
  else if (!model) configurationError = `${definition.label} ${tier} model or deployment name is required.`;

  return {
    provider,
    label: definition.label,
    apiKey,
    model,
    tier,
    baseURL,
    supportsVision: definition.supportsVision,
    maxImagesPerRequest: definition.maxImagesPerRequest || null,
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
  const isAzureSpeech = provider === 'azureSpeech';
  const label = isAzure ? 'Azure Foundry' : (isDeepgram ? 'Deepgram' : (isAzureSpeech ? 'Azure AI Speech' : 'OpenAI'));
  const keys = settings.apiKeys || {};
  const endpoints = settings.endpoints || {};
  const apiKey = String(isAzureSpeech
    ? (keys.azureSpeech || '')
    : (isAzure ? (keys.azureRealtime || keys.azure || '') : (keys[provider] || ''))).trim();
  const model = String(isAzure
    ? (transcription.azureRealtimeDeployment || '')
    : (isAzureSpeech ? ''
      : (isDeepgram ? (transcription.deepgramModel || STT_MODELS.deepgram) : (transcription.realtimeModel || STT_MODELS.realtime)))).trim();
  let endpoint = null;
  let region = null;
  let phrases = [];
  let configurationError = null;

  if (!REALTIME_PROVIDERS.includes(provider)) {
    configurationError = `Unsupported realtime transcription provider: ${provider}`;
  } else if (isAzureSpeech) {
    try {
      region = normalizeAzureSpeechRegion(transcription.azureSpeechRegion || '');
      phrases = normalizePhraseList(transcription.azureSpeechPhrases || '');
    } catch (error) { configurationError = error.message; }
  } else if (isAzure) {
    try { endpoint = normalizeAzureEndpoint((endpoints.azureRealtime || endpoints.azure || '')); }
    catch (error) { configurationError = error.message; }
  }

  if (!apiKey) configurationError = `${label} API key is required for realtime transcription.`;
  else if (isAzureSpeech && !region) configurationError = `${label} region is required for realtime transcription.`;
  else if (!isAzureSpeech && !model) configurationError = `${label} realtime deployment or model name is required.`;

  return {
    provider,
    label,
    apiKey,
    endpoint,
    region,
    phrases,
    model,
    ready: !configurationError,
    configurationError,
  };
}

module.exports = {
  PROVIDERS,
  STT_MODELS,
  REALTIME_PROVIDERS,
  getDefaultSettings,
  normalizeAzureEndpoint,
  normalizeTranscriptionLanguage,
  normalizeAzureSpeechRegion,
  normalizePhraseList,
  resolveProvider,
  resolveRealtimeTranscription,
};
