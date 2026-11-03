'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldKeepHistory, userTextForHistory } = require('../src/history-scope');
const { createChatHistory } = require('../src/chat-history');

test('every user-triggered mode keeps the conversation', () => {
  for (const mode of ['ask', 'assist', 'assist-screen', 'assist-conversation', 'say', 'followup', 'recap', 'leetcode']) {
    assert.equal(shouldKeepHistory(mode), true, mode);
  }
});

test('automatic and internal modes stay out of the conversation', () => {
  assert.equal(shouldKeepHistory('auto-assist'), false);
  assert.equal(shouldKeepHistory('slide-review'), false);
});

test('a typed question is stored as written', () => {
  assert.equal(userTextForHistory({ mode: 'ask', text: '  what changed?  ' }), 'what changed?');
});

test('an Assist press is stored under its action label', () => {
  assert.equal(userTextForHistory({ mode: 'assist', text: '', label: null }), 'Assist');
  assert.equal(userTextForHistory({ mode: 'assist-screen', text: '   ', label: 'Assist · Screen only' }), 'Assist · Screen only');
});

test('the thread never gains an empty user turn', () => {
  for (const input of [{ mode: 'assist', text: '' }, { mode: '', text: '' }, {}, undefined]) {
    assert.ok(userTextForHistory(input).length > 0, JSON.stringify(input));
  }
});

test('an Assist answer is visible to the next typed question', () => {
  // The reported bug: press Assist, get an answer, then type a follow-up and the
  // model started from nothing because the Assist turn was never recorded.
  const history = createChatHistory();
  history.addExchange(userTextForHistory({ mode: 'assist', text: '' }), 'The deploy failed because the migration lock outlived the job.');

  const turns = history.turnsFor('And what do we do about it?');
  assert.deepEqual(turns.map((turn) => turn.role), ['user', 'assistant', 'user']);
  assert.equal(turns[0].text, 'Assist');
  assert.match(turns[1].text, /migration lock/);
  assert.equal(turns[2].text, 'And what do we do about it?');
});

test('the thread still prunes to the configured budget', () => {
  const history = createChatHistory({ maxTurns: 4 });
  for (let index = 0; index < 6; index += 1) {
    history.addExchange(`question ${index}`, `answer ${index}`);
  }
  const turns = history.turnsFor('latest question');
  assert.ok(turns.length <= 4, `expected at most 4 turns, got ${turns.length}`);
  assert.equal(turns[turns.length - 1].text, 'latest question');
});

test('starting a capture clears the thread, so one meeting cannot leak into the next', () => {
  // main.js is the only place that owns this ordering and it has no executed
  // coverage, so the invariant is pinned here: the reset has to happen when
  // capture actually starts, next to the state flip, not on a schedule.
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /state\.capturing = true;[\s\S]{0,400}?chatHistory\.clear\(\);/);
});

test('a mode nobody thought about stays out of the thread', () => {
  // The old denylist failed open: a new internal mode would have been replayed
  // into the user's next question.
  for (const mode of ['slide-review', 'auto-assist', 'some-future-mode', '', 'ASK']) {
    assert.equal(shouldKeepHistory(mode), false, JSON.stringify(mode));
  }
});
