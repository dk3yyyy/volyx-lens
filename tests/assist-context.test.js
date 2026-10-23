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

test('combined Assist with no captured conversation directs the model to solve the visible task instead of echoing', () => {
  const mode = MODES.assist;
  const prompt = mode.build({ transcript: [] });
  assert.equal(prompt.includes('(none)'), false);
  assert.match(prompt, /use only the attached screenshot/i);
  assert.match(prompt, /solve the visible task/i);
  assert.match(mode.system, /never repeat, restate, or transcribe the visible problem text/i);
});

test('ready-to-speak modes attach a generic style guide with example replies', () => {
  const sayPrompt = MODES.say.build({ transcript: [{ channel: 'them', text: 'How do you handle scope creep?' }] });
  assert.match(sayPrompt, /Match this style exactly/);
  assert.match(sayPrompt, /Them: /);
  assert.match(sayPrompt, /How do you handle scope creep/);

  const draftPrompt = MODES['auto-assist'].build({
    transcript: [{ channel: 'you', text: 'I have used that stack for years.' }],
    userText: 'Why do you want to work here?',
  });
  assert.match(draftPrompt, /Match this style exactly/);
  assert.match(draftPrompt, /examples, not facts about you/i);

  // Style examples must stay generic: no invented personal facts in the mode
  // objects themselves.
  const serialized = JSON.stringify({ say: MODES.say.examples, auto: MODES['auto-assist'].examples });
  assert.doesNotMatch(serialized, /I worked at|my company|years of experience at/i);
});

test('answer modes route by the shape of the moment instead of one generic style', () => {
  for (const mode of ['assist', 'assist-screen', 'assist-conversation', 'say', 'auto-assist']) {
    assert.match(MODES[mode].system, /gets a direct answer/i, `${mode} should route by question shape`);
  }
  assert.match(MODES.assist.system, /opinion or tradeoff/i);
  assert.match(MODES.assist.system, /status request/i);
  assert.match(MODES.say.system, /objection/i);
  assert.match(MODES.say.system, /write the words to say/i);
  assert.match(MODES['auto-assist'].system, /write the words to say/i);
  assert.match(MODES.assist.system, /at most three sentences/i);
  assert.match(MODES['assist-screen'].system, /under four sentences/i);
});

test('answer prompts stay general-purpose rather than interview-specific', () => {
  const systems = Object.values(MODES).map((mode) => mode.system || '').join('\n');
  assert.doesNotMatch(systems, /STAR|behavioral interview|hiring manager|interviewer/i);
  assert.doesNotMatch(systems, /compensation expectations/i);
});
