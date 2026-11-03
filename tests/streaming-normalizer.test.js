'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamingNormalizer } = require('../src/streaming-normalizer');
const { normalizeAnswerText } = require('../src/answer-normalize');

function feed(chunks, options) {
  const stream = createStreamingNormalizer(options);
  let painted = '';
  for (const chunk of chunks) painted += stream.push(chunk);
  painted += stream.finish();
  return { painted, text: stream.text() };
}

test('a dash is normalised as its line completes, not at the end', () => {
  const { painted, text } = feed(['The plan —', ' as agreed — ships Friday.\n']);
  assert.equal(painted, 'The plan, as agreed, ships Friday.\n');
  assert.equal(text, painted, 'what was painted is what the caller stores');
});

test('a partial line is held until it completes', () => {
  const stream = createStreamingNormalizer();
  assert.equal(stream.push('half a sen'), '');
  assert.equal(stream.push('tence — ok\n'), 'half a sentence, ok\n');
});

test('a chunk boundary inside a fence does not normalise code', () => {
  // The failure this test exists for: the fence opened in an earlier chunk, so a
  // per-chunk normalize would rewrite the dash inside the command.
  const { painted } = feed(['```bash\n', 'rg --files —hidden\n', '```\n', 'Done — mostly.\n']);
  assert.match(painted, /rg --files —hidden/, 'code inside the fence is untouched');
  assert.match(painted, /Done, mostly\./);
});

test('an unclosed fence keeps everything after it verbatim', () => {
  const { painted } = feed(['intro — here\n', '```\n', 'x — y\n', 'still code — yes']);
  assert.match(painted, /intro, here/);
  assert.match(painted, /x — y/);
  assert.match(painted, /still code — yes/);
});

test('inline code and urls are protected by the line normaliser', () => {
  const { painted } = feed(['Run `echo — hi` from https://x.test/a—b — then stop.\n']);
  assert.match(painted, /`echo — hi`/);
  assert.match(painted, /https:\/\/x\.test\/a—b/);
  assert.match(painted, /then stop\./);
});

test('the streamed result matches normalising the whole answer at once', () => {
  const answer = 'Line one — with a dash.\n\n```js\nconst a = 1 — 2;\n```\nClosing — line.\n';
  const chunked = feed([...answer.match(/[\s\S]{1,7}/g)]);
  assert.equal(chunked.painted, normalizeAnswerText(answer));
});

test('an empty stream produces nothing', () => {
  const stream = createStreamingNormalizer();
  assert.equal(stream.push(''), '');
  assert.equal(stream.finish(), '');
  assert.equal(stream.text(), '');
});
