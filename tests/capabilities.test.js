const test = require('node:test');
const assert = require('node:assert/strict');

const { planScreenInput } = require('../src/capabilities');

test('vision-capable providers capture the screen when a mode requests it', () => {
  assert.deepEqual(planScreenInput({ mode: 'ask', needsScreen: true, supportsVision: true }), {
    capture: true,
    error: null,
    notice: null,
  });
});

test('explicit screen questions fail clearly for text-only providers', () => {
  const plan = planScreenInput({ mode: 'ask', needsScreen: true, supportsVision: false, providerLabel: 'DeepSeek' });
  assert.equal(plan.capture, false);
  assert.match(plan.error, /vision-capable provider/i);
  assert.equal(plan.notice, null);
});

test('combined Assist can continue from conversation context with a text-only provider', () => {
  const plan = planScreenInput({ mode: 'assist', needsScreen: true, supportsVision: false, providerLabel: 'DeepSeek' });
  assert.equal(plan.capture, false);
  assert.equal(plan.error, null);
  assert.match(plan.notice, /without a screenshot/i);
});

test('screen-only coding mode fails clearly for text-only providers', () => {
  const plan = planScreenInput({ mode: 'leetcode', needsScreen: true, supportsVision: false, providerLabel: 'DeepSeek' });
  assert.equal(plan.capture, false);
  assert.match(plan.error, /vision-capable provider/i);
});
