const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

test('question detection stays local; auto-assist only fires with explicit opt-in gating', () => {
  assert.match(main, /detectQuestion\(turn\.text\)/);
  assert.match(main, /send\('question:detected'/);
  assert.match(main, /settings\.autoAnswer !== true/);
  assert.match(main, /autoAnswerPolicy\.evaluate/);
  assert.match(main, /estimateQuestionConfidence\(question\)/);
  assert.doesNotMatch(main, /question:detected[\s\S]{0,300}runFeature\('auto-assist'/);
  assert.match(html, /id="question-suggestion"/);
  assert.match(html, /id="question-answer"/);
});

test('Draft answer targets the detected question; auto-assist is opt-in in Settings', () => {
  assert.match(renderer, /\$\('#question-answer'\)\.addEventListener\('click'/);
  assert.match(renderer, /runMode\(question \? 'auto-assist' : 'say', question \|\| ''\)/);
  assert.match(renderer, /question:detected', showQuestionSuggestion/);
  assert.match(renderer, /question:clear', clearQuestionSuggestion/);
  assert.match(html, /id="auto-answer-enabled"/);
  assert.match(renderer, /settings\.autoAnswer === true/);
  assert.match(renderer, /auto-answer-enabled'\)\.disabled = settings\.questionDetection === false/);
});
