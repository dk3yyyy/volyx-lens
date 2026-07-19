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
  assert.equal(fake.instances[0].requests[0].model, 'deepseek-v4-flash');
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

test('DeepSeek refuses to send screenshots to its text-only API', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'deepseek';
  settings.apiKeys.deepseek = 'deepseek-test-key';

  const fake = fakeOpenAI();
  const llm = createLLM(settings, { OpenAI: fake.FakeOpenAI });

  await assert.rejects(
    llm.stream({ ...baseParams, imageDataUrl: null, imageDataUrls: ['data:image/png;base64,AA=='] }),
    /does not support image input/i,
  );
  assert.equal(fake.instances.length, 0);
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
