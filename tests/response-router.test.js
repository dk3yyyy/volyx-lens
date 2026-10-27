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

function hangingStream({ onAbort } = {}) {
  return ({ signal }) => new Promise((resolve, reject) => {
    if (onAbort) onAbort();
    signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

test('a primary that outlives its deadline hands over to the fallback', async () => {
  const notices = [];
  const primary = { label: 'OpenAI', ready: true, stream: hangingStream() };
  const fallback = {
    label: 'Gemini',
    ready: true,
    supportsVision: true,
    stream: async ({ onToken }) => { onToken('Fallback answer'); return 'Fallback answer'; },
  };
  const result = await streamWithFallback({
    llm: primary,
    fallback,
    params: { imageDataUrl: null, onToken: () => {} },
    onFallback: (event) => notices.push(event),
    perAttemptTimeoutMs: 20,
  });
  assert.equal(result, 'Fallback answer', 'the answer comes from the fallback');
  assert.equal(notices.length, 1, 'the handover is reported once');
  assert.equal(notices[0].reason, 'timeout', 'and it is reported as a timeout, not a cancel');
});

test('a user cancel is not retried on the fallback', async () => {
  const outer = new AbortController();
  let fallbackCalls = 0;
  const primary = { label: 'OpenAI', ready: true, stream: hangingStream() };
  const fallback = { label: 'Gemini', ready: true, supportsVision: true, stream: async () => { fallbackCalls += 1; return 'nope'; } };
  const run = streamWithFallback({
    llm: primary,
    fallback,
    params: { imageDataUrl: null, signal: outer.signal, onToken: () => {} },
    perAttemptTimeoutMs: 5000,
  });
  setTimeout(() => outer.abort(), 10);
  await assert.rejects(run, /aborted/i);
  assert.equal(fallbackCalls, 0, 'a cancel stays a cancel');
});

test('a rejected key is reported as an auth reason before the fallback runs', async () => {
  const notices = [];
  const primary = {
    label: 'DeepSeek',
    ready: true,
    stream: async () => { const error = new Error('Incorrect API key provided'); error.status = 401; throw error; },
  };
  const fallback = { label: 'Gemini', ready: true, supportsVision: true, stream: async () => 'Fallback answer' };
  const result = await streamWithFallback({
    llm: primary,
    fallback,
    params: { imageDataUrl: null, onToken: () => {} },
    onFallback: (event) => notices.push(event),
  });
  assert.equal(result, 'Fallback answer');
  assert.equal(notices[0].reason, 'auth', 'the caller can tell the user their key was rejected');
});

test('when both attempts time out the error says so', async () => {
  const primary = { label: 'OpenAI', ready: true, stream: hangingStream() };
  const fallback = { label: 'Gemini', ready: true, supportsVision: true, stream: hangingStream() };
  await assert.rejects(
    streamWithFallback({
      llm: primary,
      fallback,
      params: { imageDataUrl: null, onToken: () => {} },
      perAttemptTimeoutMs: 20,
    }),
    (error) => {
      assert.equal(error.timedOut, true, 'the caller can distinguish a timeout from a cancel');
      return true;
    },
  );
});

test('the fallback is given a live signal, not the expired one', async () => {
  let received = null;
  const primary = { label: 'OpenAI', ready: true, stream: hangingStream() };
  const fallback = {
    label: 'Gemini',
    ready: true,
    supportsVision: true,
    stream: async ({ signal }) => { received = signal; return 'ok'; },
  };
  await streamWithFallback({
    llm: primary,
    fallback,
    params: { imageDataUrl: null, onToken: () => {} },
    perAttemptTimeoutMs: 20,
  });
  assert.ok(received instanceof AbortSignal);
  assert.equal(received.aborted, false, 'the fallback starts uncancelled');
});

test('an expired outer deadline also hands over, for callers still using one', async () => {
  const outer = new AbortController();
  const primary = { label: 'OpenAI', ready: true, stream: hangingStream() };
  const fallback = { label: 'Gemini', ready: true, supportsVision: true, stream: async () => 'Fallback answer' };
  const run = streamWithFallback({
    llm: primary,
    fallback,
    params: { imageDataUrl: null, signal: outer.signal, onToken: () => {} },
  });
  setTimeout(() => outer.abort('timeout'), 10);
  assert.equal(await run, 'Fallback answer', 'a deadline is not a cancel');
});

test('sequential attempts each get their own budget instead of sharing one', async () => {
  // The shape of a chunked recap: twelve parts, each slower than the old shared
  // budget would allow in aggregate but well inside its own deadline (VR-07).
  let calls = 0;
  const llm = {
    label: 'OpenAI',
    ready: true,
    stream: async ({ onToken }) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      onToken(`part ${calls}`);
      return `part ${calls}`;
    },
  };
  const results = [];
  for (let index = 0; index < 6; index += 1) {
    results.push(await streamWithFallback({
      llm,
      fallback: null,
      params: { imageDataUrl: null, onToken: () => {} },
      perAttemptTimeoutMs: 40,
    }));
  }
  assert.deepEqual(results, ['part 1', 'part 2', 'part 3', 'part 4', 'part 5', 'part 6'],
    'every part completes on its own clock');
  assert.equal(calls, 6);
});
