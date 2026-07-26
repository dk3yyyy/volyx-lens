const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldAttachScreen, missingContextMessage } = require('../src/response-context');

test('typed chat does not attach a screen unless the user explicitly references it', () => {
  assert.equal(shouldAttachScreen({ mode: 'ask', userText: 'Rewrite this sentence' }), false);
  assert.equal(shouldAttachScreen({ mode: 'ask', userText: 'Explain image embeddings' }), false);
  assert.equal(shouldAttachScreen({ mode: 'ask', userText: 'How does virtual memory page replacement work?' }), false);
  assert.equal(shouldAttachScreen({ mode: 'ask', userText: 'screen: explain this error' }), true);
  assert.equal(shouldAttachScreen({ mode: 'ask', userText: 'What is visible on this page?' }), true);
});

test('explicit copilot modes retain their intended screen policies', () => {
  assert.equal(shouldAttachScreen({ mode: 'assist' }), true);
  assert.equal(shouldAttachScreen({ mode: 'assist-screen' }), true);
  assert.equal(shouldAttachScreen({ mode: 'leetcode' }), true);
  assert.equal(shouldAttachScreen({ mode: 'assist-conversation' }), false);
  assert.equal(shouldAttachScreen({ mode: 'say' }), false);
});

test('conversation-only actions fail locally when no transcript exists', () => {
  for (const mode of ['assist-conversation', 'say', 'followup', 'recap']) {
    assert.match(missingContextMessage({ mode, transcript: [] }), /start listening|conversation/i);
  }
  assert.equal(missingContextMessage({ mode: 'say', transcript: [{ channel: 'them', text: 'Hello' }] }), '');
  assert.equal(missingContextMessage({ mode: 'ask', transcript: [] }), '');
});
