const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRUNCATION_MARKER,
  buildTranscriptContext,
  formatTranscriptContext,
} = require('../src/transcript-context');

function turn(channel, text) { return { channel, text }; }

test('recent AI context is hard-bounded while retaining the newest text', () => {
  const oldText = `old-${'a'.repeat(900)}`;
  const newest = `current-question-${'z'.repeat(900)}`;
  const result = buildTranscriptContext([
    turn('them', oldText),
    turn('you', 'brief reply'),
    turn('them', newest),
  ], { maxCharacters: 512 });
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 512);
  assert.match(result.text, new RegExp(`Them: ….*${'z'.repeat(80)}$`));
  assert.doesNotMatch(result.text, /old-/);
  assert.equal(result.turnsTotal, 3);
});

test('turn limits and character limits both mark omitted context', () => {
  const text = formatTranscriptContext([
    turn('them', 'first'),
    turn('you', 'second'),
    turn('them', 'third'),
  ], { maxTurns: 2, maxCharacters: 1000 });
  assert.match(text, new RegExp(`^${TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(text, /first/);
  assert.match(text, /You: second/);
  assert.match(text, /Them: third/);
});

test('short meeting context remains unchanged and preserves speaker boundaries', () => {
  const result = buildTranscriptContext([
    turn('them', 'What did we decide?'),
    turn('you', 'Ship the safer implementation.'),
  ], { maxCharacters: 2000 });
  assert.equal(result.truncated, false);
  assert.equal(result.text, 'Them: What did we decide?\nYou: Ship the safer implementation.');
});
