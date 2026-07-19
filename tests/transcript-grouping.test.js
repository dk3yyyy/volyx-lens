const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanSegmentText, appendSegmentText, joinTranscriptSegments, appendConversationSegment } = require('../src/transcript-grouping');

test('consecutive STT chunks join into one punctuation-aware speaker turn', () => {
  const text = joinTranscriptSegments([
    'By choosing two scalars, using each one to',
    'scale one of the vectors, then adding together what you get',
    'which two-dimensional vectors can you reach by',
    'altering the choices of scalars?',
    'The answer is that you can reach',
  ]);
  assert.equal(
    text,
    'By choosing two scalars, using each one to scale one of the vectors, then adding together what you get which two-dimensional vectors can you reach by altering the choices of scalars? The answer is that you can reach',
  );
});

test('closing punctuation segments attach without an artificial space', () => {
  assert.equal(appendSegmentText('That is the answer', '.'), 'That is the answer.');
  assert.equal(appendSegmentText('First', ', then second'), 'First, then second');
  assert.equal(appendSegmentText('Really', '?'), 'Really?');
});

test('segment cleanup trims and collapses whitespace without changing wording', () => {
  assert.equal(cleanSegmentText('  basis   vectors\nare useful  '), 'basis vectors are useful');
});

test('conversation turns change only when the speaker channel changes', () => {
  const turns = [];
  let nextTurnId = 0;
  const append = (channel, text, ts) => appendConversationSegment(
    turns,
    { id: ts, channel, text, ts },
    () => ++nextTurnId,
  );

  const first = append('them', 'First system chunk.', 1);
  const continued = append('them', 'Second system chunk after a breath.', 2);
  const interrupted = append('you', 'My interruption.', 3);
  const resumed = append('them', 'The system speaker resumes.', 4);

  assert.equal(first.updated, false);
  assert.equal(continued.updated, true);
  assert.equal(first.turn.id, continued.turn.id);
  assert.equal(interrupted.updated, false);
  assert.equal(resumed.updated, false);
  assert.deepEqual(turns.map(({ channel, text }) => ({ channel, text })), [
    { channel: 'them', text: 'First system chunk. Second system chunk after a breath.' },
    { channel: 'you', text: 'My interruption.' },
    { channel: 'them', text: 'The system speaker resumes.' },
  ]);
});
