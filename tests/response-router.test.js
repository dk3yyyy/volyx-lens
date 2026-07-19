const test = require('node:test');
const assert = require('node:assert/strict');
const { createResponseRoute, chooseInitialProvider, streamWithFallback } = require('../src/response-router');

function fakeFactory(configurations) {
  return (settings) => ({ provider: settings.provider, label: settings.provider, supportsVision: true, ...configurations[settings.provider] });
}

test('response route keeps default and fallback providers independent', () => {
  const route = createResponseRoute(
    { provider: 'openai', fallbackProvider: 'anthropic' },
    fakeFactory({ openai: { ready: true }, anthropic: { ready: true } })
  );
  assert.equal(route.primary.provider, 'openai');
  assert.equal(route.fallback.provider, 'anthropic');
  const selected = chooseInitialProvider(route);
  assert.equal(selected.llm.provider, 'openai');
  assert.equal(selected.fallback.provider, 'anthropic');
  assert.equal(selected.usedFallback, false);
});

test('configured fallback becomes initial provider when the default is unavailable', () => {
  const route = createResponseRoute(
    { provider: 'openai', fallbackProvider: 'gemini' },
    fakeFactory({ openai: { ready: false, configurationError: 'OpenAI key missing.' }, gemini: { ready: true } })
  );
  const selected = chooseInitialProvider(route);
  assert.equal(selected.llm.provider, 'gemini');
  assert.equal(selected.usedFallback, true);
  assert.match(selected.reason, /key missing/);
});

test('fallback retries only when the default fails before emitting text', async () => {
  const tokens = [];
  let fallbackNotice = null;
  const primary = { label: 'OpenAI', ready: true, stream: async () => { throw new Error('temporary outage'); } };
  const fallback = { label: 'Gemini', ready: true, supportsVision: true, stream: async ({ onToken }) => { onToken('Fallback answer'); return 'Fallback answer'; } };
  const result = await streamWithFallback({
    llm: primary,
    fallback,
    params: { imageDataUrl: null, onToken: (token) => tokens.push(token) },
    onFallback: (event) => { fallbackNotice = event; },
  });
  assert.equal(result, 'Fallback answer');
  assert.deepEqual(tokens, ['Fallback answer']);
  assert.equal(fallbackNotice.to, fallback);
});

test('fallback never mixes a second answer after the default emitted text', async () => {
  let fallbackCalls = 0;
  const tokens = [];
  const primary = { label: 'OpenAI', ready: true, stream: async ({ onToken }) => { onToken('Partial'); throw new Error('stream interrupted'); } };
  const fallback = { label: 'Gemini', ready: true, supportsVision: true, stream: async () => { fallbackCalls += 1; } };
  await assert.rejects(() => streamWithFallback({ llm: primary, fallback, params: { onToken: (token) => tokens.push(token) } }), /stream interrupted/);
  assert.deepEqual(tokens, ['Partial']);
  assert.equal(fallbackCalls, 0);
});

test('an aborted primary request never starts the fallback provider', async () => {
  let fallbackCalls = 0;
  const controller = new AbortController();
  const primary = { label: 'OpenAI', ready: true, stream: async () => { controller.abort(); throw new Error('aborted'); } };
  const fallback = { label: 'Gemini', ready: true, supportsVision: true, stream: async () => { fallbackCalls += 1; } };
  await assert.rejects(() => streamWithFallback({ llm: primary, fallback, params: { signal: controller.signal, onToken() {} } }), /aborted/);
  assert.equal(fallbackCalls, 0);
});

test('text-only fallback is not used for a multi-image task-context request', async () => {
  let fallbackCalls = 0;
  const primary = { label: 'OpenAI', ready: true, stream: async () => { throw new Error('image request failed'); } };
  const fallback = { label: 'DeepSeek', ready: true, supportsVision: false, stream: async () => { fallbackCalls += 1; } };
  await assert.rejects(() => streamWithFallback({ llm: primary, fallback, params: { imageDataUrls: ['data:image/png;base64,AA=='], onToken() {} } }), /image request failed/);
  assert.equal(fallbackCalls, 0);
});
