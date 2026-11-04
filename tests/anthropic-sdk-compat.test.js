'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// The unit tests inject a fake Anthropic class, so they cannot catch an SDK major
// changing construction, headers, or the event stream shape. This drives the real
// client against a local server that speaks the Messages streaming protocol.
const Anthropic = require('@anthropic-ai/sdk');
const { streamAnthropic } = require('../src/llm');

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

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
  return { server, requests, baseURL: `http://127.0.0.1:${server.address().port}` };
}

test('the installed anthropic client streams text through the adapter', async () => {
  const { server, requests, baseURL } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }));
    res.write(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
    res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }));
    res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }));
    res.write(sse('content_block_stop', { index: 0 }));
    res.write(sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }));
    res.write(sse('message_stop', {}));
    res.end();
  });
  const tokens = [];
  let finished = null;
  // The adapter constructs the client from the key alone, so the SDK's own base
  // URL override is the only way to point the real client at a local server.
  const previousBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = baseURL;
  try {
    const text = await streamAnthropic({
      Anthropic,
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      system: 'be brief',
      turns: [{ role: 'user', text: 'hi' }],
      maxTokens: 64,
      onToken: (token) => tokens.push(token),
      onFinish: (info) => { finished = info.reason; },
    });
    assert.equal(text, 'Hello');
    assert.deepEqual(tokens, ['Hel', 'lo']);
    assert.equal(finished, 'end_turn');
    assert.equal(requests[0].url, '/v1/messages');
    // SDK 1.x moved from x-api-key to Authorization: Bearer. The credential must
    // reach the server either way; pinning one header would fail on the next bump.
    const keyHeader = requests[0].headers['x-api-key'] || (requests[0].headers.authorization || '').replace(/^Bearer\s+/, '');
    assert.equal(keyHeader, 'sk-ant-test', 'the API key reaches the API');
    assert.ok(requests[0].headers['anthropic-version'], 'the SDK sends its API version header');
    assert.equal(requests[0].body.model, 'claude-test');
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].body.max_tokens, 64);
    assert.equal(requests[0].body.system, 'be brief');
  } finally {
    if (previousBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousBase;
    server.close();
  }
});
