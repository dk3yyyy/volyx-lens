const test = require('node:test');
const assert = require('node:assert/strict');
const { getDefaultSettings } = require('../src/provider-config');
const { MAX_OUTPUT_TOKENS, azureRouteKind, runResponseDiagnostic } = require('../src/response-diagnostic');

test('response diagnostic uses only the selected provider tier and one bounded text-only request', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'openai';
  settings.fallbackProvider = 'gemini';
  settings.models.azure.fast = 'fast-deployment';
  settings.models.azure.smart = 'gpt-5.6-luna';
  settings.apiKeys.azure = 'private-key';
  settings.endpoints.azure = 'https://demo.services.ai.azure.com/openai/v1';
  let diagnosticSettings;
  let request;
  const result = await runResponseDiagnostic({
    settings,
    provider: 'azure',
    tier: 'smart',
    now: (() => { let value = 100; return () => (value += 25); })(),
    createLLM(value) {
      diagnosticSettings = value;
      return {
        ready: true,
        provider: 'azure',
        label: 'Azure Foundry',
        model: value.models.azure.smart,
        baseURL: value.endpoints.azure,
        supportsVision: true,
        async stream(params) { request = params; return 'OK'; },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.equal(result.tier, 'smart');
  assert.equal(result.route, 'foundry-resource');
  assert.equal(result.latencyMs, 25);
  assert.equal(diagnosticSettings.provider, 'azure');
  assert.equal(diagnosticSettings.smart, true);
  assert.equal(diagnosticSettings.fallbackProvider, '');
  assert.equal(request.maxTokens, MAX_OUTPUT_TOKENS);
  assert.equal(request.imageDataUrl, null);
  assert.deepEqual(request.imageDataUrls, []);
  assert.match(request.turns[0].text, /exactly OK/);
  assert.equal(typeof request.onToken, 'function');
  assert.ok(request.signal instanceof AbortSignal);
});

test('Azure 404 diagnostic identifies deployment and route without exposing endpoint or key', async () => {
  const settings = getDefaultSettings();
  settings.apiKeys.azure = 'top-secret-key';
  settings.models.azure.fast = 'gpt-5.6-luna';
  settings.endpoints.azure = 'https://private-resource.services.ai.azure.com/api/projects/private-project/openai/v1';
  const result = await runResponseDiagnostic({
    settings,
    provider: 'azure',
    tier: 'fast',
    createLLM() {
      return {
        ready: true,
        label: 'Azure Foundry',
        model: 'gpt-5.6-luna',
        baseURL: settings.endpoints.azure,
        supportsVision: true,
        async stream() { const error = new Error(`404 at ${settings.endpoints.azure} using top-secret-key`); error.status = 404; throw error; },
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'http_404');
  assert.equal(result.route, 'project');
  assert.match(result.message, /gpt-5\.6-luna/);
  assert.match(result.message, /project-scoped endpoint/);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /top-secret-key|private-resource|private-project/);
});

test('response diagnostic times out and aborts a hanging provider request', async () => {
  const settings = getDefaultSettings();
  let observedSignal;
  const result = await runResponseDiagnostic({
    settings,
    provider: 'openai',
    tier: 'fast',
    timeoutMs: 5,
    createLLM() {
      return {
        ready: true,
        label: 'OpenAI',
        model: 'test-model',
        baseURL: null,
        supportsVision: true,
        stream({ signal }) {
          observedSignal = signal;
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
        },
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'timeout');
  assert.match(result.message, /15 seconds/);
  assert.equal(observedSignal.aborted, true);
});

test('response diagnostic returns local configuration errors without sending a request', async () => {
  let streamed = false;
  const result = await runResponseDiagnostic({
    settings: getDefaultSettings(),
    provider: 'anthropic',
    tier: 'fast',
    createLLM() {
      return { ready: false, label: 'Anthropic', model: 'claude-haiku-4-5', supportsVision: true, configurationError: 'Anthropic API key is required.', async stream() { streamed = true; } };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'configuration');
  assert.equal(result.latencyMs, 0);
  assert.equal(streamed, false);
});

test('Azure route classification distinguishes project and resource endpoints', () => {
  assert.equal(azureRouteKind('https://one.services.ai.azure.com/api/projects/demo/openai/v1'), 'project');
  assert.equal(azureRouteKind('https://one.services.ai.azure.com/openai/v1'), 'foundry-resource');
  assert.equal(azureRouteKind('https://one.openai.azure.com/openai/v1'), 'azure-openai-resource');
  assert.equal(azureRouteKind('not-a-url'), 'invalid');
});
