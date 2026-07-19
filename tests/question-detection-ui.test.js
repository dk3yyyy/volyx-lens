const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

test('question detection emits a local suggestion and never starts an AI request in main', () => {
  assert.match(main, /detectQuestion\(turn\.text\)/);
  assert.match(main, /send\('question:detected'/);
  assert.doesNotMatch(main, /question:detected[\s\S]{0,300}runFeature/);
  assert.match(html, /id="question-suggestion"/);
  assert.match(html, /id="question-answer"/);
});

test('a paid answer request happens only after the user clicks Draft answer', () => {
  assert.match(renderer, /\$\('#question-answer'\)\.addEventListener\('click'/);
  assert.match(renderer, /runMode\('say', ''\)/);
  assert.match(renderer, /question:detected', showQuestionSuggestion/);
  assert.match(renderer, /question:clear', clearQuestionSuggestion/);
});
