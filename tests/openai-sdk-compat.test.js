'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// These run the REAL openai client against a local server, so an SDK major bump
// that changes construction, request shape, or SSE parsing fails here. The unit
// tests inject a fake class and cannot catch that.
const OpenAI = require('openai');
const { streamOpenAICompatible } = require('../src/llm');

const CHUNK = (content, finish = null) => `data: ${JSON.stringify({
  id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1700000000, model: 'gpt-test',
  choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
})}\n\n`;

async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      requests.push(parsed);
      handler(req, res, parsed);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}

test('the installed openai client streams through the adapter', async () => {
  const { server, requests, baseURL } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(CHUNK('Hel'));
    res.write(CHUNK('lo', 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const tokens = [];
  let finished = null;
  try {
    const text = await streamOpenAICompatible({
      OpenAI,
      clientOptions: { apiKey: 'sk-test', baseURL },
      model: 'gpt-test',
      system: 'be brief',
      turns: [{ role: 'user', text: 'hi' }],
      maxTokens: 64,
      onToken: (token) => tokens.push(token),
      onFinish: (info) => { finished = info.reason; },
    });

    assert.equal(text, 'Hello');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.equal(finished, 'stop');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].headers.authorization, 'Bearer sk-test');
    assert.equal(requests[0].body.model, 'gpt-test');
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].body.max_tokens, 64);
    assert.equal(requests[0].body.messages[0].role, 'system');
    assert.match(requests[0].body.messages[0].content, /be brief/);
  } finally {
    server.close();
  }
});

test('the legacy max_tokens rejection still falls back on the installed client', async () => {
  let call = 0;
  const { server, requests, baseURL } = await startServer((req, res, parsed) => {
    call += 1;
    if (call === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          type: 'invalid_request_error',
        },
      }));
      return;
    }
    assert.equal(parsed.body.max_completion_tokens, 64, 'the retry uses the new parameter');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(CHUNK('ok', 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const text = await streamOpenAICompatible({
      OpenAI,
      clientOptions: { apiKey: 'sk-test', baseURL },
      model: 'gpt-test',
      system: 's',
      turns: [{ role: 'user', text: 'hi' }],
      maxTokens: 64,
      onToken: () => {},
    });
    assert.equal(text, 'ok');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.max_tokens, 64);
  } finally {
    server.close();
  }
});

test('the Azure header shape still builds a real request (api-key in, Authorization out)', async () => {
  // Azure Foundry authenticates with an api-key header, so the adapter suppresses
  // the SDK's Authorization header with a null value. That is exactly the kind of
  // thing a major SDK bump can start rejecting.
  const { server, requests, baseURL } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(CHUNK('azure', 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const text = await streamOpenAICompatible({
      OpenAI,
      clientOptions: { apiKey: 'azure-key', baseURL, defaultHeaders: { 'api-key': 'azure-key', Authorization: null } },
      model: 'deployment',
      system: 's',
      turns: [{ role: 'user', text: 'hi' }],
      maxTokens: 32,
      onToken: () => {},
    });
    assert.equal(text, 'azure');
    assert.equal(requests[0].headers['api-key'], 'azure-key');
    assert.equal(requests[0].headers.authorization, undefined, 'the SDK Authorization header is suppressed');
  } finally {
    server.close();
  }
});
