const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatHistory } = require('../src/chat-history');

test('chat history returns prior user and assistant turns before the current question', () => {
  const history = createChatHistory({ maxTurns: 6, maxCharacters: 200 });
  history.addExchange('What is RAG?', 'Retrieval-augmented generation.');

  assert.deepEqual(history.turnsFor('Explain the second word.'), [
    { role: 'user', text: 'What is RAG?' },
    { role: 'assistant', text: 'Retrieval-augmented generation.' },
    { role: 'user', text: 'Explain the second word.' },
  ]);
});

test('chat history is bounded to complete recent exchanges and can be cleared', () => {
  const history = createChatHistory({ maxTurns: 4, maxCharacters: 34 });
  history.addExchange('old question', 'old answer');
  history.addExchange('new question', 'new answer');

  assert.deepEqual(history.turnsFor('next'), [
    { role: 'user', text: 'new question' },
    { role: 'assistant', text: 'new answer' },
    { role: 'user', text: 'next' },
  ]);
  history.clear();
  assert.deepEqual(history.turnsFor('fresh'), [{ role: 'user', text: 'fresh' }]);
});

test('chat history ignores incomplete or empty exchanges', () => {
  const history = createChatHistory();
  history.addExchange('question', '');
  history.addExchange('', 'answer');
  assert.deepEqual(history.turnsFor('current'), [{ role: 'user', text: 'current' }]);
});

test('chat history falls back to finite defaults for non-finite limits', () => {
  const turnBounded = createChatHistory({ maxTurns: Number.NaN });
  for (let index = 1; index <= 5; index += 1) {
    turnBounded.addExchange(`question ${index}`, `answer ${index}`);
  }
  assert.equal(turnBounded.size(), 3);

  const characterBounded = createChatHistory({ maxTurns: 20, maxCharacters: Number.POSITIVE_INFINITY });
  characterBounded.addExchange('q'.repeat(7000), 'a'.repeat(7000));
  assert.equal(characterBounded.size(), 0);
});
