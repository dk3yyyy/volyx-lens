const test = require('node:test');
const assert = require('node:assert/strict');
const {
  speechSimilarity,
  areCrossTalkDuplicates,
  findCrossTalkDuplicate,
} = require('../src/transcript-dedupe');

const video = 'Basis vectors are what those scalars actually, you know, scale.';
const leakedMic = 'Basis vectors are what those scalars actually you know scale';

test('near-identical substantial speech across You and Them is classified as cross-talk', () => {
  const them = { id: 1, channel: 'them', text: video, ts: 1000 };
  const you = { channel: 'you', text: leakedMic, ts: 1200 };
  assert.ok(speechSimilarity(them.text, you.text) >= 0.82);
  assert.equal(areCrossTalkDuplicates(them, you), true);
});

test('short acknowledgements and genuinely different speech are never suppressed', () => {
  assert.equal(areCrossTalkDuplicates(
    { channel: 'them', text: 'Okay, yes.' },
    { channel: 'you', text: 'Okay, yes.' },
  ), false);
  assert.equal(areCrossTalkDuplicates(
    { channel: 'them', text: 'The basis vectors determine how coordinates are interpreted.' },
    { channel: 'you', text: 'Could you explain that example again more slowly?' },
  ), false);
});

test('same-channel repetitions remain valid transcript turns', () => {
  assert.equal(areCrossTalkDuplicates(
    { channel: 'them', text: video },
    { channel: 'them', text: video },
  ), false);
});

test('duplicate search is bounded by recent opposite-channel arrivals', () => {
  const turns = [{ id: 7, channel: 'them', text: video, ts: 1000 }];
  const arrivals = new Map([[7, 10_000]]);
  const recent = findCrossTalkDuplicate(turns, { channel: 'you', text: leakedMic }, arrivals, 15_000);
  assert.equal(recent.turn.id, 7);
  const expired = findCrossTalkDuplicate(turns, { channel: 'you', text: leakedMic }, arrivals, 19_000);
  assert.equal(expired, null);
});

test('a substantial containment match tolerates one channel missing a few edge words', () => {
  const full = 'When you think about coordinates as scalars the basis vectors define what those scalars mean in the space';
  const clipped = 'coordinates as scalars the basis vectors define what those scalars mean in the space';
  assert.equal(areCrossTalkDuplicates(
    { channel: 'them', text: full },
    { channel: 'you', text: clipped },
  ), true);
});
