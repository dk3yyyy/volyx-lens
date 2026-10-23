const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createLLM } = require('../src/llm');
const { getDefaultSettings } = require('../src/provider-config');
const { MODES } = require('../src/prompts');
const { encodeCapture, MAX_LONG_EDGE_PX } = require('../src/screen');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function fakeOpenAI({ finishReason = 'stop', chunks = ['OK'] } = {}) {
  const instances = [];
  class FakeOpenAI {
    constructor(options) {
      this.options = options;
      this.requests = [];
      instances.push(this);
      this.chat = {
        completions: {
          create: async (request) => {
            this.requests.push(request);
            return (async function* stream() {
              for (let index = 0; index < chunks.length; index += 1) {
                const last = index === chunks.length - 1;
                yield {
                  choices: [{
                    delta: { content: chunks[index] },
                    ...(last ? { finish_reason: finishReason } : {}),
                  }],
                };
              }
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
  onToken() {},
};

test('a mode output budget overrides the tier default', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'deepseek';
  settings.apiKeys.deepseek = 'test-key';
  settings.models.deepseek.fast = 'fast-model';
  settings.smart = false;
  const fake = fakeOpenAI();

  const llm = createLLM(settings, { OpenAI: fake.FakeOpenAI });
  await llm.stream({ ...baseParams, maxTokens: 1600 });

  assert.equal(fake.instances[0].requests[0].max_tokens, 1600);

  await llm.stream(baseParams);
  assert.equal(fake.instances[1].requests[0].max_tokens, 700, 'tier default still applies when a mode has no budget');
});

test('a cut-off answer reports its finish reason', async () => {
  const settings = getDefaultSettings();
  settings.provider = 'deepseek';
  settings.apiKeys.deepseek = 'test-key';
  settings.models.deepseek.fast = 'fast-model';
  const fake = fakeOpenAI({ finishReason: 'length' });

  const reasons = [];
  const llm = createLLM(settings, { OpenAI: fake.FakeOpenAI });
  await llm.stream({ ...baseParams, onFinish: ({ reason }) => reasons.push(reason) });

  assert.deepEqual(reasons, ['length']);
});

test('Gemini reserves headroom for thinking tokens on both tiers', async () => {
  const calls = [];
  class FakeGoogleGenAI {
    constructor() {
      this.models = {
        generateContentStream: async (request) => {
          calls.push(request);
          return (async function* stream() {
            yield { text: 'OK', candidates: [{ finishReason: 'MAX_TOKENS' }] };
          }());
        },
      };
    }
  }
  const settings = getDefaultSettings();
  settings.provider = 'gemini';
  settings.apiKeys.gemini = 'test-key';
  settings.models.gemini.fast = 'gemini-test';
  settings.smart = false;

  const reasons = [];
  const llm = createLLM(settings, { GoogleGenAI: FakeGoogleGenAI });
  const output = await llm.stream({ ...baseParams, maxTokens: 700, onFinish: ({ reason }) => reasons.push(reason) });

  assert.equal(output, 'OK');
  assert.equal(calls[0].config.maxOutputTokens, 700 + 1024);
  assert.deepEqual(calls[0].config.thinkingConfig, { thinkingLevel: 'low' });
  assert.deepEqual(reasons, ['MAX_TOKENS']);
});

test('screen captures are downscaled to the vision long edge before encoding', () => {
  const resizes = [];
  const makeImage = (width, height) => ({
    getSize: () => ({ width, height }),
    resize: ({ width: w, height: h }) => {
      resizes.push({ width: w, height: h });
      const nextWidth = w || Math.round(width * (h / height));
      const nextHeight = h || Math.round(height * (w / width));
      return makeImage(nextWidth, nextHeight);
    },
    toJPEG: () => Buffer.from('jpeg'),
    toDataURL: () => 'data:image/png;base64,png',
  });

  const landscape = encodeCapture(makeImage(5120, 2880), { format: 'jpeg', quality: 70 });
  assert.deepEqual(resizes[0], { width: MAX_LONG_EDGE_PX, height: undefined });
  assert.match(landscape, /^data:image\/jpeg;base64,/);

  const portrait = encodeCapture(makeImage(1800, 3200), { format: 'jpeg', quality: 70 });
  assert.deepEqual(resizes[1], { width: undefined, height: MAX_LONG_EDGE_PX });

  resizes.length = 0;
  encodeCapture(makeImage(1200, 800), { format: 'jpeg', quality: 70 });
  assert.deepEqual(resizes, [], 'small images are never upscaled');
});

test('each feature declares a budget sized to its answer', () => {
  for (const [mode, def] of Object.entries(MODES)) {
    assert.ok(def.maxTokens, `${mode} should declare maxTokens`);
    assert.ok(def.maxTokens.fast > 0 && def.maxTokens.smart >= def.maxTokens.fast, `${mode} budgets should grow with the smart tier`);
  }
  assert.ok(MODES.leetcode.maxTokens.smart >= 2000, 'coding solutions need room for approach, code, and complexity');
  assert.ok(MODES.say.maxTokens.fast <= 600, 'one-line replies should not buy a large budget');
});

test('screen modes require a vision provider and pass their budget through', () => {
  const main = read('main.js');

  assert.match(main, /const selection = chooseInitialProvider\(route, \{ requiresVision: needsScreen \}\)/);
  assert.match(main, /const modeTokenBudget = def\.maxTokens/);
  assert.match(main, /maxTokens: modeTokenBudget \|\| undefined/);
  assert.match(main, /onFinish: \(\{ reason \}\) => \{ if \(TRUNCATED_FINISH_REASON\.test/);
  assert.match(main, /The answer stopped at the model output limit/);
  assert.match(main, /maxLongEdge: MAX_LONG_EDGE_PX, format: 'jpeg', quality: REQUEST_JPEG_QUALITY/);
});

test('Gemini smart tier keeps full reasoning and reserves more headroom', async () => {
  const calls = [];
  class FakeGoogleGenAI {
    constructor() {
      this.models = {
        generateContentStream: async (request) => {
          calls.push(request);
          return (async function* stream() {
            yield { text: 'OK', candidates: [{ finishReason: 'STOP' }] };
          }());
        },
      };
    }
  }
  const settings = getDefaultSettings();
  settings.provider = 'gemini';
  settings.apiKeys.gemini = 'test-key';
  settings.models.gemini.smart = 'gemini-pro-test';
  settings.smart = true;

  await createLLM(settings, { GoogleGenAI: FakeGoogleGenAI }).stream({ ...baseParams, maxTokens: 1600 });

  assert.equal(calls[0].config.maxOutputTokens, 1600 + 4096);
  assert.equal(calls[0].config.thinkingConfig, undefined, 'smart tier leaves the model reasoning level alone');
});
