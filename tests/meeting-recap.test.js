const test = require('node:test');
const assert = require('node:assert/strict');
const { planMeetingRecap, splitBounded } = require('../src/meeting-recap');

function turnsWithCharacters(characters) {
  return [{ channel: 'them', text: 'x'.repeat(characters) }];
}

test('normal meeting recap remains a single model request', () => {
  const plan = planMeetingRecap([{ channel: 'them', text: 'Short meeting.' }]);
  assert.equal(plan.requiresChunking, false);
  assert.equal(plan.requestCount, 1);
});

test('long meeting recap is split into bounded sequential parts plus one final request', () => {
  const plan = planMeetingRecap(turnsWithCharacters(70000));
  assert.equal(plan.requiresChunking, true);
  assert.ok(plan.chunks.length > 1);
  assert.equal(plan.requestCount, plan.chunks.length + 1);
  assert.ok(plan.chunks.every((chunk) => chunk.length <= 12000));
  assert.equal(plan.sampled, false);
});

test('extreme meetings cap paid part requests and sample across the full session', () => {
  const plan = planMeetingRecap(turnsWithCharacters(300000));
  assert.equal(plan.chunks.length, 12);
  assert.equal(plan.requestCount, 13);
  assert.equal(plan.sampled, true);
});

test('bounded splitter prefers natural boundaries', () => {
  const chunks = splitBounded('Them: first section\nYou: second section\nThem: third section', 30);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 30));
});
