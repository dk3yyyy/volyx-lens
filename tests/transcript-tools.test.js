const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTurns, normalizeSpokenDigits, formatTranscript, transcriptFilename } = require('../src/transcript-tools');

const turns = [
  { id: 1, channel: 'you', text: 'Tell me about the role.', ts: Date.UTC(2026, 0, 2, 3, 4, 5) },
  { id: 2, channel: 'them', text: 'It focuses on reliable AI systems.', ts: Date.UTC(2026, 0, 2, 3, 4, 8) },
];

test('transcript exports preserve timestamps and speaker attribution in TXT and Markdown', () => {
  const txt = formatTranscript(turns, 'txt', Date.UTC(2026, 0, 2));
  assert.match(txt, /\[03:04:05\] You: Tell me about the role\./);
  assert.match(txt, /\[03:04:08\] Them: It focuses on reliable AI systems\./);
  const markdown = formatTranscript(turns, 'md', Date.UTC(2026, 0, 2));
  assert.match(markdown, /^# Volyx Lens transcript/);
  assert.match(markdown, /\*\*03:04:05 · You:\*\*/);
  assert.match(markdown, /\*\*03:04:08 · Them:\*\*/);
});

test('JSON transcript export is structured, bounded, and versioned', () => {
  const parsed = JSON.parse(formatTranscript(turns, 'json', Date.UTC(2026, 0, 2)));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.turns.length, 2);
  assert.deepEqual(parsed.turns[0], turns[0]);
  const many = Array.from({ length: 510 }, (_, index) => ({ channel: 'invalid', text: `turn-${index}`, ts: index }));
  const normalized = normalizeTurns(many);
  assert.equal(normalized.length, 500);
  assert.equal(normalized[0].text, 'turn-10');
  assert.equal(normalized[0].channel, 'them');
});

test('transcript filename uses only a timestamp and supported extension', () => {
  const filename = transcriptFilename('md', Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(filename, 'volyx-lens-transcript-2026-01-02T03-04-05-000Z.md');
  assert.match(transcriptFilename('exe', 0), /\.txt$/);
});

test('spoken digit sequences become digits and preserve leading zeroes', () => {
  assert.equal(normalizeSpokenDigits('The code is zero two one.'), 'The code is 021.');
  assert.equal(normalizeSpokenDigits('Call zero eight zero three five five five zero one two three.'), 'Call 08035550123.');
  assert.equal(normalizeSpokenDigits('Reference nine 4 zero 2.'), 'Reference 9402.');
  assert.equal(normalizeSpokenDigits('One, two, four, zero.'), '1240.');
});

test('spoken digit normalization leaves ordinary quantities and enumerations unchanged', () => {
  assert.equal(normalizeSpokenDigits('I have two options and one concern.'), 'I have two options and one concern.');
  assert.equal(normalizeSpokenDigits('Choose one, two, or three.'), 'Choose one, two, or three.');
  assert.equal(normalizeSpokenDigits('Choose zero, one, two.'), 'Choose zero, one, two.');
  assert.equal(normalizeSpokenDigits('The options are zero, one, two.'), 'The options are zero, one, two.');
  assert.equal(normalizeSpokenDigits('I saw one two three birds.'), 'I saw one two three birds.');
  assert.equal(normalizeSpokenDigits('Someone two three four joined later.'), 'Someone two three four joined later.');
  assert.equal(normalizeSpokenDigits('The answer is twenty-one.'), 'The answer is twenty-one.');
  assert.equal(normalizeSpokenDigits('Version one two is available.'), 'Version one two is available.');
});

test('number context converts sequences without zeroes', () => {
  assert.equal(normalizeSpokenDigits('The PIN is four five six seven.'), 'The PIN is 4567.');
  assert.equal(normalizeSpokenDigits('Account one two three four is ready.'), 'Account 1234 is ready.');
  assert.equal(normalizeSpokenDigits('The code is one, two, three.'), 'The code is 123.');
});
