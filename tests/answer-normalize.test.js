'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAnswerText } = require('../src/answer-normalize');

test('dashes between words become commas', () => {
  assert.equal(
    normalizeAnswerText('The plan — as agreed — ships Friday.'),
    'The plan, as agreed, ships Friday.'
  );
  assert.equal(normalizeAnswerText('wait—what'), 'wait, what');
  // The en dash is the same family as the em dash and follows the same rule.
  assert.equal(
    normalizeAnswerText('The team – all of us – agreed.'),
    'The team, all of us, agreed.'
  );
});

test('a dash between two digits becomes a hyphen', () => {
  assert.equal(normalizeAnswerText('2019–2020'), '2019-2020');
  assert.equal(normalizeAnswerText('2019—2020'), '2019-2020');
  assert.equal(normalizeAnswerText('Q3 2019–2020 and 2020–2021.'), 'Q3 2019-2020 and 2020-2021.');
  // Chains need lookarounds, otherwise overlapping matches skip one dash.
  assert.equal(normalizeAnswerText('2019–2020–2021'), '2019-2020-2021');
});

test('a spaced dash is not a numeric range', () => {
  // "2019 — 2020" is not a dash *between* two digits, so the comma rule wins.
  // Guessing that it is a range would also rewrite "2019 — the year it
  // shipped", where a hyphen would be wrong.
  assert.equal(normalizeAnswerText('2019 — 2020'), '2019, 2020');
});

test('a fenced code block is copied byte for byte', () => {
  const code =
    '```js\n' +
    'const flags = ["--flag", "--other"]; // — “in code”  \n' +
    '  if (a  === b) { return 2019—2020; }\n' +
    '```';
  const input = `Run — this.\n${code}\nDone — that.`;

  const out = normalizeAnswerText(input);
  assert.ok(out.includes(code), 'the whole fence, language tag included, is untouched');
  assert.equal(out, `Run, this.\n${code}\nDone, that.`);
});

test('fenced code keeps its language tag and CLI-looking content', () => {
  const code = '```sh\nnpm test -- --reporter=spec — "as is"\n```';
  assert.equal(
    normalizeAnswerText(code),
    code,
    'a document that is only a fence is returned unchanged'
  );
});

test('indented prose around a fence is normalised while the fence is not', () => {
  const code = '```sh\nnpm test -- --reporter=spec  —  “as is”\n```';
  const input = `  Before  — “the plan”\n${code}\n    After — “the plan”`;

  const out = normalizeAnswerText(input);
  assert.equal(
    out,
    `  Before, "the plan"\n${code}\n    After, "the plan"`,
    'prose indentation is kept; the fence, its double spaces, and its curly quotes are not'
  );
});

test('curly quotes become straight quotes in prose', () => {
  assert.equal(
    normalizeAnswerText('“The plan” and ‘the date’ are set.'),
    '"The plan" and \'the date\' are set.'
  );
});

test('artifacts left behind by dash replacement collapse', () => {
  assert.equal(normalizeAnswerText('one —  two'), 'one, two'); // doubled space
  assert.equal(normalizeAnswerText('one , two'), 'one, two'); // space before comma
  assert.equal(normalizeAnswerText('one — , two'), 'one, two'); // ,, that came from two rules
  assert.equal(normalizeAnswerText('one,,  two'), 'one, two'); // doubled comma
  assert.equal(normalizeAnswerText('He paused — .'), 'He paused.'); // ", ." -> "."
});

test('normalising twice is the same as normalising once', () => {
  const mixed = [
    'The plan — as agreed — ships Friday.',
    'wait—what “now”',
    '2019–2020 and 2020—2021, said the ‘reviewer’.',
    'spaced , comma and doubled  spaces and one — , two',
    'He paused — .',
    '    indented — prose',
    '```js',
    'const flag = "--x"; // — “kept” 2019–2020',
    '  if (a  === b) { return a; }',
    '```',
    'after — fence  ',
  ].join('\n');

  const once = normalizeAnswerText(mixed);
  const twice = normalizeAnswerText(once);

  assert.equal(twice, once, 'second pass changes nothing');
  assert.notEqual(once, mixed, 'first pass actually normalised something');
  assert.ok(once.includes('// — “kept” 2019–2020'), 'the fence survived both passes');
});

test('non-string input is returned unchanged', () => {
  for (const value of [null, undefined, 42, true]) {
    assert.equal(normalizeAnswerText(value), value);
  }
  const object = { text: 'still — here' };
  assert.equal(normalizeAnswerText(object), object, 'identity, not a copied value');
});

test('empty string returns empty string', () => {
  assert.equal(normalizeAnswerText(''), '');
});

test('an unterminated fence is left alone instead of being read as prose', () => {
  // There is no safe way to know where the code ends, and mangling a real
  // command is worse than leaving a stray dash in unfinished output.
  const input = 'Intro — text\n```js\nconst x = 1; // — still code\n';
  assert.equal(normalizeAnswerText(input), 'Intro, text\n```js\nconst x = 1; // — still code\n');
});

test('a shorter fence does not close a longer one', () => {
  const body = '````md\n```\ninside — fence “x”\n````';
  const input = `Before — text\n${body}\nAfter — text`;
  assert.equal(normalizeAnswerText(input), `Before, text\n${body}\nAfter, text`);
});
