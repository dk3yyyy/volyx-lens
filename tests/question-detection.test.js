const test = require('node:test');
const assert = require('node:assert/strict');
const { detectQuestion, estimateQuestionConfidence } = require('../src/question-detection');

test('detects direct and interview-style questions locally', () => {
  assert.equal(detectQuestion('What was the hardest reliability issue you solved?'), 'What was the hardest reliability issue you solved?');
  assert.equal(detectQuestion('Could you walk me through your experience with AI agents'), 'Could you walk me through your experience with AI agents');
  assert.equal(detectQuestion('I would like to know how you handle production incidents.'), 'I would like to know how you handle production incidents.');
});

test('returns the latest question from a growing grouped speaker turn', () => {
  assert.equal(
    detectQuestion('We covered the role. The team is distributed. How do you work across time zones?'),
    'How do you work across time zones?',
  );
});

test('ignores statements and short ambiguous fragments', () => {
  assert.equal(detectQuestion('The meeting begins at nine.'), null);
  assert.equal(detectQuestion('How are'), null);
  assert.equal(detectQuestion('Okay?'), null);
});

test('confidence is high for explicit spoken questions and low for statements', () => {
  assert.equal(estimateQuestionConfidence('What is the plan?'), 1);
  assert.ok(estimateQuestionConfidence('Can you share the document?') >= 0.6);
  assert.ok(estimateQuestionConfidence('Tell me more about the timeline') >= 0.5);
  assert.ok(estimateQuestionConfidence('How does the billing work') >= 0.5);
  assert.ok(estimateQuestionConfidence('The meeting is at three') < 0.5);
  assert.equal(estimateQuestionConfidence(''), 0);
});
