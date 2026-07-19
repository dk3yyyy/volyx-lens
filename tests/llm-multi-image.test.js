const test = require('node:test');
const assert = require('node:assert/strict');
const { createLLM } = require('../src/llm');
const { getDefaultSettings } = require('../src/provider-config');

const images = ['data:image/jpeg;base64,QQ==', 'data:image/png;base64,Qg=='];
const params = { system: 'System', turns: [{ role: 'user', text: 'Analyze in order.' }], imageDataUrls: images, onToken() {} };

test('Anthropic receives all task-context images in order before the text prompt', async () => {
  let request;
  let requestOptions;
  class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async (value, options) => {
          request = value;
          requestOptions = options;
          return (async function* stream() {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } };
          }());
        },
      };
    }
  }
  const settings = getDefaultSettings();
  settings.provider = 'anthropic';
  settings.apiKeys.anthropic = 'test-key';
  const controller = new AbortController();
  const result = await createLLM(settings, { Anthropic: FakeAnthropic }).stream({ ...params, signal: controller.signal });
  assert.equal(result, 'OK');
  const content = request.messages[0].content;
  assert.deepEqual(content.slice(0, 2).map((part) => `data:${part.source.media_type};base64,${part.source.data}`), images);
  assert.deepEqual(content[2], { type: 'text', text: 'Analyze in order.' });
  assert.equal(requestOptions.signal, controller.signal);
});

test('Gemini receives all task-context images in order after the text prompt', async () => {
  let request;
  class FakeGoogleGenAI {
    constructor() {
      this.models = {
        generateContentStream: async (value) => {
          request = value;
          return (async function* stream() { yield { text: 'OK' }; }());
        },
      };
    }
  }
  const settings = getDefaultSettings();
  settings.provider = 'gemini';
  settings.apiKeys.gemini = 'test-key';
  const controller = new AbortController();
  const result = await createLLM(settings, { GoogleGenAI: FakeGoogleGenAI }).stream({ ...params, signal: controller.signal });
  assert.equal(result, 'OK');
  const parts = request.contents[0].parts;
  assert.deepEqual(parts[0], { text: 'Analyze in order.' });
  assert.deepEqual(parts.slice(1).map((part) => `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`), images);
  assert.equal(request.config.abortSignal, controller.signal);
});
