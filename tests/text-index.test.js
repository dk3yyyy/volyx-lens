const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTextOverlap, scoreTextRelevance } = require('../src/text-index');

function codePage(start, end) {
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const line = start + offset;
    return `${line} const value${line} = computeItem(source${line});`;
  }).join('\n');
}

test('code pages 1–60 and 40–100 are linked with the 40–60 overlap removed only from local ranking text', () => {
  const overlap = detectTextOverlap(codePage(1, 60), codePage(40, 100));
  assert.ok(overlap);
  assert.equal(overlap.overlapLines, 21);
  assert.equal(overlap.lineStart, 40);
  assert.equal(overlap.lineEnd, 60);
  assert.equal(overlap.confidence, 100);
  assert.doesNotMatch(overlap.uniqueLaterText, /value40|value50|value60/);
  assert.match(overlap.uniqueLaterText, /value61/);
  assert.match(overlap.uniqueLaterText, /value100/);
});

test('shared application chrome does not create a false scroll-overlap link', () => {
  const chrome = ['Volyx Lens', 'File Edit View', 'index.js', 'Problems Output'];
  const first = [...chrome, ...codePage(1, 30).split('\n')].join('\n');
  const second = [...chrome, ...codePage(80, 110).split('\n')].join('\n');
  assert.equal(detectTextOverlap(first, second), null);
});

test('unrelated and visually repeated low-information code lines do not count as overlap', () => {
  const first = ['1 function alpha() {', '2 return source;', '3 }', '4 }'].join('\n');
  const second = ['20 function beta() {', '21 return target;', '22 }', '23 }'].join('\n');
  assert.equal(detectTextOverlap(first, second), null);
});

test('relevance scoring prefers unique later code for line 80 and earlier code for line 20', () => {
  const first = codePage(1, 60);
  const second = codePage(40, 100);
  const overlap = detectTextOverlap(first, second);
  assert.ok(scoreTextRelevance('Why does value80 fail on line 80?', overlap.uniqueLaterText, second) > scoreTextRelevance('Why does value80 fail on line 80?', first, first));
  assert.ok(scoreTextRelevance('Explain value20 on line 20', first, first) > scoreTextRelevance('Explain value20 on line 20', overlap.uniqueLaterText, second));
});

test('overlap-only terms are discounted on the later page without hiding its full coverage', () => {
  const first = codePage(1, 60);
  const second = codePage(40, 100);
  const overlap = detectTextOverlap(first, second);
  const query = 'value50 source50';
  const earlierScore = scoreTextRelevance(query, first, first);
  const laterScore = scoreTextRelevance(query, overlap.uniqueLaterText, second);
  assert.ok(earlierScore > laterScore);
  assert.ok(laterScore > 0);
});
