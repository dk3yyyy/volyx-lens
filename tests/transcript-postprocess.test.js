'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
