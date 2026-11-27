'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inspectVocabulary,
  parseVocabulary,
  parseTranscriptRules,
  postProcessTranscript,
} = require('../src/transcript-postprocess');

test('vocabulary parsing accepts comma/newline lists, deduplicates, and bounds terms', () => {
  assert.deepEqual(parseVocabulary('Volyx Lens, parakeet\nVOLYX LENS, GPT-4o,  x  '), ['Volyx Lens', 'parakeet', 'GPT-4o']);
  assert.deepEqual(parseVocabulary(['One', 'Two, Three', 'one']), ['One', 'Two', 'Three']);
  assert.deepEqual(parseVocabulary('a\n' + 'x'.repeat(100)), []);
  assert.deepEqual(parseVocabulary(null), []);
});

test('vocabulary parsing keeps meaningful two-character hints such as AI, Q3, and X1', () => {
  assert.deepEqual(parseVocabulary('AI, Q3, X1, 3D, ML'), ['AI', 'Q3', 'X1', '3D', 'ML']);
  assert.deepEqual(parseVocabulary('ai, 42, a, xy, A1'), ['A1'], 'noise shorter than three characters is still rejected');
});

test('vocabulary parsing reports every entry it rejects instead of dropping it silently', () => {
  const longTerm = 'y'.repeat(90);
  const result = inspectVocabulary(`AI, Q3, a, 42, xy, ${longTerm}`);
  assert.deepEqual(result.terms, ['AI', 'Q3']);
  assert.equal(result.rejectedCount, 4);
  assert.deepEqual(result.rejected.map((item) => [item.term, item.reason]), [
    ['a', 'too_short'],
    ['42', 'too_short'],
    ['xy', 'too_short'],
    [longTerm.slice(0, 40), 'too_long'],
  ]);
  const limited = inspectVocabulary('Alpha, Beta', { limit: 1 });
  assert.deepEqual(limited.terms, ['Alpha']);
  assert.deepEqual(limited.rejected.map((item) => [item.term, item.reason]), [['Beta', 'over_limit']]);
  assert.equal(inspectVocabulary('').rejectedCount, 0, 'separators are not reported as rejected terms');
});

test('transcript rules parse heard-to-replacement lines and reject malformed input', () => {
  assert.deepEqual(parseTranscriptRules('volyx lens => Volyx Lens\nparakeet=>Parakeet\ninvalid line\nx =>'), [
    { from: 'volyx lens', to: 'Volyx Lens' },
    { from: 'parakeet', to: 'Parakeet' },
  ]);
  assert.deepEqual(parseTranscriptRules('a => ' + 'x'.repeat(200)), []);
});

test('post-processing applies longest whole-term rules without replacing inside words', () => {
  const result = postProcessTranscript('We use volyx lens and Volyx Lens, not volyx lensary.', {
    rules: [
      { from: 'volyx lens', to: 'Volyx Lens' },
      { from: 'lens', to: 'camera' },
    ],
    normalizeDigits: false,
  });
  assert.equal(result.text, 'We use Volyx Lens and Volyx Lens, not volyx lensary.');
  assert.equal(result.rawText, 'We use volyx lens and Volyx Lens, not volyx lensary.');
  assert.equal(result.changed, true);
  assert.deepEqual(result.replacements, ['volyx lens']);
});

test('post-processing normalizes spoken digits only when enabled', () => {
  assert.equal(postProcessTranscript('The code is zero two one.', { normalizeDigits: true }).text, 'The code is 021.');
  assert.equal(postProcessTranscript('The code is zero two one.', { normalizeDigits: false }).text, 'The code is zero two one.');
  assert.equal(postProcessTranscript('The code is zero two one.', { enabled: false }).text, 'The code is zero two one.');
});

test('post-processing trims, bounds output, and reports empty input', () => {
  const empty = postProcessTranscript('   ');
  assert.deepEqual(empty, { text: '', rawText: '', changed: false, replacements: [] });
  const long = postProcessTranscript('x'.repeat(20000), { normalizeDigits: false });
  assert.equal(long.text.length, 12000);
  assert.equal(long.rawText.length, 12000);
});

test('vocabulary parsing rejects terms the realtime seed cannot carry', () => {
  const { terms, rejected, rejectedCount } = inspectVocabulary('x'.repeat(41));
  assert.equal(terms.length, 0, 'a term past the provider budget is not accepted');
  assert.equal(rejectedCount, 1);
  assert.equal(rejected[0].reason, 'too_long');
});

test('two-character hints in uncased scripts survive', () => {
  assert.deepEqual(parseVocabulary('华为, AI, xy, 42'), ['华为', 'AI']);
});
