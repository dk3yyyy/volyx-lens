const test = require('node:test');
const assert = require('node:assert/strict');

const { createLLM } = require('../src/llm');
const { getDefaultSettings } = require('../src/provider-config');

function fakeOpenAI() {
  const instances = [];

  class FakeOpenAI {
    constructor(options) {
      this.options = options;
      this.requests = [];
      this.requestOptions = [];
      instances.push(this);
      this.chat = {
        completions: {
          create: async (request, options) => {
            this.requests.push(request);
            this.requestOptions.push(options);
            return (async function* stream() {
              yield { choices: [{ delta: { content: 'OK' } }] };
            }());
          },
        },
      };
    }
  }

  return { FakeOpenAI, instances };
}

const baseParams = {
  system: 'You are helpful.',
  turns: [{ role: 'user', text: 'Reply with OK.' }],
  imageDataUrl: null,
  onToken() {},
};

test('Azure Foundry routes through the configured OpenAI v1 endpoint with api-key auth', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'azure';
  settings.apiKeys.azure = 'azure-test-key';
  settings.endpoints.azure = 'https://demo.services.ai.azure.com/openai/v1/';
  settings.models.azure.fast = 'vision-deployment';

  const fake = fakeOpenAI();
  const llm = createLLM(settings, { OpenAI: fake.FakeOpenAI });
  const output = await llm.stream(baseParams);

  assert.equal(output, 'OK');
  assert.equal(fake.instances.length, 1);
  assert.equal(fake.instances[0].options.baseURL, 'https://demo.services.ai.azure.com/openai/v1');
  assert.equal(fake.instances[0].options.defaultHeaders['api-key'], 'azure-test-key');
  assert.equal(fake.instances[0].requests[0].model, 'vision-deployment');
});

test('DeepSeek routes through its official OpenAI-compatible endpoint', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'deepseek';
  settings.apiKeys.deepseek = 'deepseek-test-key';

  const fake = fakeOpenAI();
  const llm = createLLM(settings, { OpenAI: fake.FakeOpenAI });
  await llm.stream(baseParams);

  assert.equal(fake.instances[0].options.baseURL, 'https://api.deepseek.com');
  assert.equal(fake.instances[0].requests[0].model, 'deepseek-flash');
});

test('Opencode Go uses the Go base URL, a stable session header, and a reasoning budget', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'opencodeGo';
  settings.apiKeys.opencodeGo = 'oc_sk_test-key';

  const fake = fakeOpenAI();
  await createLLM(settings, { OpenAI: fake.FakeOpenAI }).stream(baseParams);

  const options = fake.instances[0].options;
  assert.equal(options.baseURL, 'https://opencode.ai/inference/go/openai/v1');
  assert.equal(options.apiKey, 'oc_sk_test-key');
  assert.match(options.defaultHeaders['x-opencode-session'], /^ses_[a-f0-9]{32}$/);
  assert.equal(fake.instances[0].requests[0].model, 'deepseek-v4.1-flash');
  assert.equal(fake.instances[0].requests[0].max_tokens, 2048);

  // A mode's short budget is raised to the reasoning floor.
  const floor = fakeOpenAI();
  await createLLM(settings, { OpenAI: floor.FakeOpenAI }).stream({ ...baseParams, maxTokens: 400 });
  assert.equal(floor.instances[0].requests[0].max_tokens, 2048);

  // A budget above the floor is left alone.
  const above = fakeOpenAI();
  await createLLM(settings, { OpenAI: above.FakeOpenAI }).stream({ ...baseParams, maxTokens: 8000 });
  assert.equal(above.instances[0].requests[0].max_tokens, 8000);

  const smart = fakeOpenAI();
  settings.smart = true;
  await createLLM(settings, { OpenAI: smart.FakeOpenAI }).stream(baseParams);
  assert.equal(smart.instances[0].requests[0].model, 'gpt-6-luna');
  assert.equal(smart.instances[0].requests[0].max_tokens, 4096);
  assert.equal(
    smart.instances[0].options.defaultHeaders['x-opencode-session'],
    options.defaultHeaders['x-opencode-session'],
    'the session id stays stable for the app run',
  );
});

test('Opencode Go refuses images for a text-only model instead of hanging', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'opencodeGo';
  settings.apiKeys.opencodeGo = 'oc_sk_test-key';
  settings.models.opencodeGo.fast = 'deepseek-v4-pro';

  const fake = fakeOpenAI();
  await assert.rejects(
    createLLM(settings, { OpenAI: fake.FakeOpenAI }).stream({ ...baseParams, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
    /is not enabled for image input/,
  );
  assert.equal(fake.instances.length, 0, 'no request is sent');

  // The Smart tier is gated independently, including multi-image requests.
  const smartSettings = { ...settings, smart: true };
  smartSettings.models = { ...settings.models, opencodeGo: { fast: 'deepseek-v4.1-flash', smart: 'glm-5.3' } };
  const smartFake = fakeOpenAI();
  await assert.rejects(
    createLLM(smartSettings, { OpenAI: smartFake.FakeOpenAI }).stream({ ...baseParams, imageDataUrls: ['data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,/9j/'] }),
    /is not enabled for image input/,
  );
  assert.equal(smartFake.instances.length, 0, 'no smart-tier request is sent');
});

test('Groq routes through its official OpenAI-compatible endpoint', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'groq';
  settings.apiKeys.groq = 'groq-test-key';

  const fake = fakeOpenAI();
  const llm = createLLM(settings, { OpenAI: fake.FakeOpenAI });
  await llm.stream(baseParams);

  assert.equal(fake.instances[0].options.baseURL, 'https://api.groq.com/openai/v1');
  assert.equal(fake.instances[0].requests[0].model, 'llama-3.1-8b-instant');
});

test('per-tier endpoint overrides route fast and smart tiers to different base URLs', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'groq';
  settings.apiKeys.groq = 'groq-test-key';
  settings.endpointByTier.groq = {
    fast: 'https://fast.groq.example/v1',
    smart: 'https://smart.groq.example/v1',
  };

  const fast = fakeOpenAI();
  await createLLM(settings, { OpenAI: fast.FakeOpenAI }).stream(baseParams);
  assert.equal(fast.instances[0].options.baseURL, 'https://fast.groq.example/v1');
  assert.equal(fast.instances[0].requests[0].model, 'llama-3.1-8b-instant');

  const smartSettings = { ...settings, smart: true };
  const smart = fakeOpenAI();
  await createLLM(smartSettings, { OpenAI: smart.FakeOpenAI }).stream(baseParams);
  assert.equal(smart.instances[0].options.baseURL, 'https://smart.groq.example/v1');
  assert.equal(smart.instances[0].requests[0].model, 'llama-3.3-70b-versatile');
});

test('per-tier API keys route to the OpenAI-compatible client for each tier', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'nvidia';
  settings.apiKeys.nvidia = 'nvapi-shared-key';
  settings.apiKeys['nvidia.fast'] = 'nvapi-fast-key';
  settings.apiKeys['nvidia.smart'] = 'nvapi-smart-key';

  const fast = fakeOpenAI();
  await createLLM(settings, { OpenAI: fast.FakeOpenAI }).stream(baseParams);
  assert.equal(fast.instances[0].options.apiKey, 'nvapi-fast-key');

  const smartSettings = { ...settings, smart: true };
  const smart = fakeOpenAI();
  await createLLM(smartSettings, { OpenAI: smart.FakeOpenAI }).stream(baseParams);
  assert.equal(smart.instances[0].options.apiKey, 'nvapi-smart-key');
});

test('OpenRouter routes through its official OpenAI-compatible endpoint', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'openrouter';
  settings.apiKeys.openrouter = 'openrouter-test-key';

  const fake = fakeOpenAI();
  const llm = createLLM(settings, { OpenAI: fake.FakeOpenAI });
  await llm.stream(baseParams);

  assert.equal(fake.instances[0].options.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(fake.instances[0].requests[0].model, 'meta-llama/llama-3.1-8b-instruct');
});

test('Groq refuses to send screenshots to its text-only API', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'groq';
  settings.apiKeys.groq = 'groq-test-key';

  const fake = fakeOpenAI();
  const llm = createLLM(settings, { OpenAI: fake.FakeOpenAI });

  await assert.rejects(
    llm.stream({ ...baseParams, imageDataUrl: null, imageDataUrls: ['data:image/png;base64,AA=='] }),
    /is not enabled for image input/i,
  );
  assert.equal(fake.instances.length, 0);
});

test('Ollama routes to a local OpenAI-compatible endpoint without an API key', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'ollama';

  const fake = fakeOpenAI();
  const llm = createLLM(settings, { OpenAI: fake.FakeOpenAI });
  await llm.stream(baseParams);

  assert.equal(fake.instances[0].options.baseURL, 'http://localhost:11434/v1');
  assert.equal(fake.instances[0].options.apiKey, 'ollama');
  assert.equal(fake.instances[0].requests[0].model, 'llama3.2');
});

test('OpenAI-compatible providers preserve multiple screen images in capture order', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'openai';
  settings.apiKeys.openai = 'openai-test-key';
  const fake = fakeOpenAI();
  const llm = createLLM(settings, { OpenAI: fake.FakeOpenAI });
  const images = ['data:image/jpeg;base64,QQ==', 'data:image/png;base64,Qg=='];
  await llm.stream({ ...baseParams, imageDataUrl: null, imageDataUrls: images });
  const content = fake.instances[0].requests[0].messages[1].content;
  assert.equal(content[0].type, 'text');
  assert.deepEqual(content.slice(1).map((part) => part.image_url.url), images);
});

test('OpenAI-compatible requests receive the active cancellation signal', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'openai';
  settings.apiKeys.openai = 'openai-test-key';
  const fake = fakeOpenAI();
  const controller = new AbortController();
  await createLLM(settings, { OpenAI: fake.FakeOpenAI }).stream({ ...baseParams, signal: controller.signal });
  assert.equal(fake.instances[0].requestOptions[0].signal, controller.signal);
});

test('DeepSeek Flash accepts screenshots while V4 Pro refuses them', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'deepseek';
  settings.apiKeys.deepseek = 'deepseek-test-key';

  const visionFake = fakeOpenAI();
  const flash = createLLM(settings, { OpenAI: visionFake.FakeOpenAI });
  await flash.stream({ ...baseParams, imageDataUrl: null, imageDataUrls: ['data:image/png;base64,AA=='] });
  assert.equal(visionFake.instances.length, 1);

  settings.smart = true;
  const textFake = fakeOpenAI();
  const pro = createLLM(settings, { OpenAI: textFake.FakeOpenAI });
  await assert.rejects(
    pro.stream({ ...baseParams, imageDataUrl: null, imageDataUrls: ['data:image/png;base64,AA=='] }),
    /is not enabled for image input/i,
  );
  assert.equal(textFake.instances.length, 0);
});

test('an aborted OpenAI-compatible request never retries with another token parameter', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'azure';
  settings.apiKeys.azure = 'azure-test-key';
  settings.endpoints.azure = 'https://demo.services.ai.azure.com/openai/v1';
  settings.models.azure.fast = 'deployment';
  const controller = new AbortController();
  let calls = 0;
  class AbortingOpenAI {
    constructor() {
      this.chat = { completions: { create: async () => {
        calls += 1;
        controller.abort();
        const error = new Error("Unsupported parameter: 'max_completion_tokens'.");
        error.status = 400;
        throw error;
      } } };
    }
  }
  await assert.rejects(() => createLLM(settings, { OpenAI: AbortingOpenAI }).stream({ ...baseParams, signal: controller.signal }), /Unsupported parameter/);
  assert.equal(calls, 1);
});

test('Azure retries once with max_tokens when a deployment rejects max_completion_tokens', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'azure';
  settings.apiKeys.azure = 'azure-test-key';
  settings.endpoints.azure = 'https://demo.services.ai.azure.com/openai/v1';
  settings.models.azure.fast = 'legacy-deployment';
  const requests = [];

  class FallbackOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (request) => {
            requests.push(request);
            if (requests.length === 1) {
              const error = new Error("Unsupported parameter: 'max_completion_tokens'. Use 'max_tokens' instead.");
              error.status = 400;
              throw error;
            }
            return (async function* stream() {
              yield { choices: [{ delta: { content: 'OK' } }] };
            }());
          },
        },
      };
    }
  }

  const output = await createLLM(settings, { OpenAI: FallbackOpenAI }).stream(baseParams);
  assert.equal(output, 'OK');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_completion_tokens, 700);
  assert.equal(requests[1].max_tokens, 700);
  assert.equal('max_completion_tokens' in requests[1], false);
});
