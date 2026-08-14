const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoAssistPolicy } = require('../src/auto-assist');

test('auto-assist is disabled by default', () => {
  const policy = createAutoAssistPolicy();
  const decision = policy.evaluate({ question: 'What is the plan?', now: 0, busy: false, capturing: true });
  assert.equal(decision.shouldAnswer, false);
  assert.equal(decision.reason, 'disabled');
});

test('a fresh confident question answers when enabled and idle', () => {
  const policy = createAutoAssistPolicy({ enabled: true, cooldownMs: 60000 });
  const decision = policy.evaluate({ question: 'What is the plan?', now: 1000, busy: false, capturing: true });
  assert.equal(decision.shouldAnswer, true);
  assert.equal(decision.reason, 'ok');
});

test('never answers while a feature request is already running', () => {
  const policy = createAutoAssistPolicy({ enabled: true });
  const decision = policy.evaluate({ question: 'What is the plan?', now: 1000, busy: true, capturing: true });
  assert.equal(decision.shouldAnswer, false);
  assert.equal(decision.reason, 'busy');
});

test('never answers when listening is not active', () => {
  const policy = createAutoAssistPolicy({ enabled: true });
  const decision = policy.evaluate({ question: 'What is the plan?', now: 1000, busy: false, capturing: false });
  assert.equal(decision.shouldAnswer, false);
  assert.equal(decision.reason, 'not-capturing');
});

test('deduplicates the same question within the cooldown window', () => {
  const policy = createAutoAssistPolicy({ enabled: true, cooldownMs: 60000 });
  policy.record('What is the plan?', 1000);
  const decision = policy.evaluate({ question: 'what is the plan?', now: 20000, busy: false, capturing: true });
  assert.equal(decision.shouldAnswer, false);
  assert.equal(decision.reason, 'duplicate');
});

test('applies cooldown to a different question after answering', () => {
  const policy = createAutoAssistPolicy({ enabled: true, cooldownMs: 60000 });
  policy.record('What is the plan?', 1000);
  const decision = policy.evaluate({ question: 'Can you share the document?', now: 30000, busy: false, capturing: true });
  assert.equal(decision.shouldAnswer, false);
  assert.equal(decision.reason, 'cooldown');
});

test('a per-evaluate cooldown override can tighten or widen the window', () => {
  const policy = createAutoAssistPolicy({ enabled: true, cooldownMs: 60000 });
  policy.record('What is the plan?', 1000);
  const wide = policy.evaluate({ question: 'What is the plan?', now: 20000, busy: false, capturing: true });
  assert.equal(wide.shouldAnswer, false);
  assert.equal(wide.reason, 'duplicate');
  const narrow = policy.evaluate({ question: 'What is the plan?', now: 20000, busy: false, capturing: true, cooldownMs: 5000 });
  assert.equal(narrow.shouldAnswer, true);
});

test('allows the same question again after the cooldown expires', () => {
  const policy = createAutoAssistPolicy({ enabled: true, cooldownMs: 60000 });
  policy.record('What is the plan?', 1000);
  const decision = policy.evaluate({ question: 'What is the plan?', now: 1000 + 60001, busy: false, capturing: true });
  assert.equal(decision.shouldAnswer, true);
});

test('ignores empty questions', () => {
  const policy = createAutoAssistPolicy({ enabled: true });
  const decision = policy.evaluate({ question: '   ', now: 1000, busy: false, capturing: true });
  assert.equal(decision.shouldAnswer, false);
  assert.equal(decision.reason, 'empty');
});

test('reset clears the cooldown and dedupe history', () => {
  const policy = createAutoAssistPolicy({ enabled: true, cooldownMs: 60000 });
  policy.record('What is the plan?', 1000);
  policy.reset();
  const decision = policy.evaluate({ question: 'What is the plan?', now: 2000, busy: false, capturing: true });
  assert.equal(decision.shouldAnswer, true);
});
