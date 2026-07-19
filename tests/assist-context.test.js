const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../src/prompts');

test('screen-only Assist requires a screenshot and excludes transcript text from its prompt', () => {
  const mode = MODES['assist-screen'];
  assert.equal(mode.needsScreen, true);
  const prompt = mode.build({ transcript: [{ channel: 'them', text: 'private old conversation' }] });
  assert.equal(prompt.includes('private old conversation'), false);
});

test('conversation-only Assist does not request a screenshot and includes only recent transcript', () => {
  const mode = MODES['assist-conversation'];
  assert.equal(mode.needsScreen, false);
  const prompt = mode.build({ transcript: [{ channel: 'them', text: 'What is the deadline?' }] });
  assert.match(prompt, /What is the deadline/);
  assert.match(mode.system, /no screenshot is available/i);
});

test('combined Assist retains screen and recent conversation behavior', () => {
  const mode = MODES.assist;
  assert.equal(mode.needsScreen, true);
  assert.match(mode.build({ transcript: [{ channel: 'you', text: 'Combined context' }] }), /Combined context/);
});
