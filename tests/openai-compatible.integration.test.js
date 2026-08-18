const test = require('node:test');
const assert = require('node:assert/strict');

const { createLLM } = require('../src/llm');
const { getDefaultSettings } = require('../src/provider-config');

function streamingResponse() {
  const chunk = JSON.stringify({
    id: 'test',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }],
  });
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function captureSdkRequest(settings) {
  const BaseOpenAI = require('openai');
  const requests = [];
  const fakeFetch = async (url, init = {}) => {
    requests.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(init.body),
    });
    return streamingResponse();
  };

  class TestOpenAI extends BaseOpenAI {
    constructor(options) {
      super({ ...options, fetch: fakeFetch });
    }
  }

  const tokens = [];
  const output = await createLLM(settings, { OpenAI: TestOpenAI }).stream({
    system: 'You are helpful.',
    turns: [{ role: 'user', text: 'Reply with OK.' }],
    imageDataUrl: null,
    onToken: (token) => tokens.push(token),
  });
  return { requests, output, tokens };
}

test('real OpenAI SDK constructs the Azure Foundry request without network access', { concurrency: false }, async () => {
  const settings = getDefaultSettings();
  settings.provider = 'azure';
  settings.apiKeys.azure = 'azure-test-key';
  settings.endpoints.azure = 'https://demo.services.ai.azure.com/api/projects/volyx-lens-project/openai/v1';
  settings.models.azure.fast = 'vision-deployment';

  const result = await captureSdkRequest(settings);
  assert.equal(result.output, 'OK');
  assert.deepEqual(result.tokens, ['OK']);
  assert.equal(result.requests[0].url, 'https://demo.services.ai.azure.com/api/projects/volyx-lens-project/openai/v1/chat/completions');
  assert.equal(result.requests[0].headers['api-key'], 'azure-test-key');
  assert.equal('authorization' in result.requests[0].headers, false);
  assert.equal(result.requests[0].body.model, 'vision-deployment');
  assert.equal(result.requests[0].body.stream, true);
  assert.equal(result.requests[0].body.max_completion_tokens, 700);
  assert.equal('max_tokens' in result.requests[0].body, false);
});

test('real OpenAI SDK constructs the official DeepSeek request without network access', { concurrency: false }, async () => {
  const settings = getDefaultSettings();
  settings.provider = 'deepseek';
  settings.apiKeys.deepseek = 'deepseek-test-key';

  const result = await captureSdkRequest(settings);
  assert.equal(result.output, 'OK');
  assert.equal(result.requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(result.requests[0].headers.authorization, 'Bearer deepseek-test-key');
  assert.equal(result.requests[0].body.model, 'deepseek-v4-flash');
  assert.equal(result.requests[0].body.max_tokens, 700);
});

test('real OpenAI SDK constructs the official NVIDIA request without network access', { concurrency: false }, async () => {
  const settings = getDefaultSettings();
  settings.provider = 'nvidia';
  settings.apiKeys.nvidia = 'nvapi-test-key';

  const result = await captureSdkRequest(settings);
  assert.equal(result.output, 'OK');
  assert.equal(result.requests[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(result.requests[0].headers.authorization, 'Bearer nvapi-test-key');
  assert.equal(result.requests[0].body.model, 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1');
  assert.equal(result.requests[0].body.max_tokens, 700);
  assert.deepEqual(result.requests[0].body.chat_template_kwargs, { enable_thinking: false, force_nonempty_content: true });

  settings.smart = true;
  const smart = await captureSdkRequest(settings);
  assert.equal(smart.requests[0].body.model, 'meta/llama-3.2-11b-vision-instruct');
});
