const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDefaultSettings,
  normalizeAzureEndpoint,
  normalizeTranscriptionLanguage,
  resolveProvider,
  resolveRealtimeTranscription,
} = require('../src/provider-config');

test('automatic transcription language aliases are omitted', () => {
  assert.equal(normalizeTranscriptionLanguage('auto'), '');
  assert.equal(normalizeTranscriptionLanguage(' Automatic '), '');
  assert.equal(normalizeTranscriptionLanguage('EN'), 'en');
});

test('defaults include Azure Foundry and DeepSeek without changing the app name', () => {
  const settings = getDefaultSettings();

  assert.equal(settings.apiKeys.azure, '');
  assert.equal(settings.apiKeys.deepseek, '');
  assert.deepEqual(settings.models.azure, { fast: '', smart: '' });
  assert.deepEqual(settings.models.anthropic, { fast: 'claude-haiku-4-5', smart: 'claude-sonnet-5' });
  assert.deepEqual(settings.models.gemini, { fast: 'gemini-3.5-flash', smart: 'gemini-2.5-pro' });
  assert.deepEqual(settings.models.deepseek, {
    fast: 'deepseek-v4-flash',
    smart: 'deepseek-v4-pro',
  });
  assert.equal(settings.endpoints.azure, '');
});

test('Azure Foundry endpoint normalization accepts only official HTTPS OpenAI v1 endpoints', () => {
  assert.equal(
    normalizeAzureEndpoint('https://demo.services.ai.azure.com'),
    'https://demo.services.ai.azure.com/openai/v1'
  );
  assert.equal(
    normalizeAzureEndpoint('https://demo.openai.azure.com/'),
    'https://demo.openai.azure.com/openai/v1'
  );
  assert.equal(
    normalizeAzureEndpoint('https://demo.services.ai.azure.com/openai/v1/'),
    'https://demo.services.ai.azure.com/openai/v1',
  );
  assert.equal(
    normalizeAzureEndpoint('https://demo.openai.azure.com/openai/v1'),
    'https://demo.openai.azure.com/openai/v1',
  );
  assert.equal(
    normalizeAzureEndpoint('https://demo.services.ai.azure.com/api/projects/my-project/openai/v1/'),
    'https://demo.services.ai.azure.com/api/projects/my-project/openai/v1',
  );

  for (const endpoint of [
    'http://demo.services.ai.azure.com/openai/v1',
    'https://demo.services.ai.azure.com/api/projects/volyx-lens',
    'https://demo.services.ai.azure.com/arbitrary/openai/v1',
    'https://evil.example/openai/v1',
    'https://demo.services.ai.azure.com/openai/v1?redirect=evil',
  ]) {
    assert.throws(() => normalizeAzureEndpoint(endpoint), /Azure Foundry endpoint/);
  }
});

test('Azure Foundry requires an API key, deployment name, and valid endpoint', () => {
  const settings = getDefaultSettings();
  settings.provider = 'azure';
  settings.apiKeys.azure = 'test-key';
  settings.models.azure.fast = 'gpt-4o-deployment';

  let resolved = resolveProvider(settings);
  assert.equal(resolved.ready, false);
  assert.match(resolved.configurationError, /endpoint/i);

  settings.endpoints.azure = 'https://demo.services.ai.azure.com/openai/v1';
  resolved = resolveProvider(settings);
  assert.equal(resolved.ready, true);
  assert.equal(resolved.model, 'gpt-4o-deployment');
  assert.equal(resolved.baseURL, settings.endpoints.azure);
  assert.equal(resolved.supportsVision, true);
});

test('DeepSeek uses the official API endpoint and is marked text-only', () => {
  const settings = getDefaultSettings();
  settings.provider = 'deepseek';
  settings.apiKeys.deepseek = 'test-key';

  const resolved = resolveProvider(settings);
  assert.equal(resolved.ready, true);
  assert.equal(resolved.baseURL, 'https://api.deepseek.com');
  assert.equal(resolved.model, 'deepseek-v4-flash');
  assert.equal(resolved.supportsVision, false);
});

test('Azure realtime transcription resolves its own deployment and reuses Azure credentials', () => {
  const settings = getDefaultSettings();
  settings.transcription.realtimeProvider = 'azure';
  settings.transcription.azureRealtimeDeployment = 'volyx-lens-whisper';
  const sharedCredential = ['azure', 'credential'].join('-');
  settings.apiKeys.azure = sharedCredential;
  settings.endpoints.azure = 'https://demo.services.ai.azure.com/api/projects/volyx-lens/openai/v1';

  assert.deepEqual(resolveRealtimeTranscription(settings), {
    provider: 'azure',
    label: 'Azure Foundry',
    apiKey: sharedCredential,
    endpoint: 'https://demo.services.ai.azure.com/api/projects/volyx-lens/openai/v1',
    model: 'volyx-lens-whisper',
    ready: true,
    configurationError: null,
  });
});

test('Azure realtime can use a separate resource key and endpoint', () => {
  const settings = getDefaultSettings();
  settings.transcription.realtimeProvider = 'azure';
  settings.transcription.azureRealtimeDeployment = 'dedicated-whisper';
  settings.apiKeys.azure = 'shared-key';
  settings.endpoints.azure = 'https://shared.openai.azure.com/openai/v1';
  settings.apiKeys.azureRealtime = 'realtime-key';
  settings.endpoints.azureRealtime = 'https://realtime.openai.azure.com/openai/v1';

  const resolved = resolveRealtimeTranscription(settings);
  assert.equal(resolved.apiKey, 'realtime-key');
  assert.equal(resolved.endpoint, 'https://realtime.openai.azure.com/openai/v1');
  assert.equal(resolved.model, 'dedicated-whisper');
});
