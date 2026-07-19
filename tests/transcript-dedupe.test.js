const test = require('node:test');
const assert = require('node:assert/strict');
const {
  speechSimilarity,
  substantialPhraseOverlap,
  fuzzyShortFragmentOverlap,
  areCrossTalkDuplicates,
  findCrossTalkDuplicate,
  findCrossTalkDuplicateAcrossCandidateWindow,
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
  const expired = findCrossTalkDuplicate(turns, { channel: 'you', text: leakedMic }, arrivals, 26_000);
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

test('staggered speaker bleed is suppressed when STT splits the same phrase at different boundaries', () => {
  const directFirst = { id: 10, channel: 'them', text: "Gribbed vector coordinates where there's this back and forth", ts: 1000 };
  const leakedFirst = { channel: 'you', text: "Where there's this back and forth between, for example", ts: 4000 };
  assert.ok(substantialPhraseOverlap(directFirst.text, leakedFirst.text) >= 0.5);
  assert.equal(areCrossTalkDuplicates(directFirst, leakedFirst), true);

  const leakedSecond = { id: 11, channel: 'you', text: 'members and two-dimensional vectors. Now', ts: 7000 };
  const directSecond = { channel: 'them', text: 'two-dimensional vectors Now, I imagine the vector', ts: 7100 };
  assert.ok(substantialPhraseOverlap(leakedSecond.text, directSecond.text) >= 0.5);
  assert.equal(areCrossTalkDuplicates(leakedSecond, directSecond), true);
});

test('brief generic overlap and simultaneous independent speech remain intact', () => {
  assert.equal(areCrossTalkDuplicates(
    { channel: 'them', text: 'I think that is the important part of this design.' },
    { channel: 'you', text: 'That is the important question, but my concern is latency.' },
  ), false);
  assert.equal(areCrossTalkDuplicates(
    { channel: 'them', text: 'Could you explain the vector coordinates in this example?' },
    { channel: 'you', text: 'Yes, I understand the vector coordinates, but I have another question.' },
  ), false);
});

test('short microphone echo with STT substitutions is suppressed across the observed delay', () => {
  const direct = {
    id: 20,
    channel: 'them',
    text: "The vector that these coordinates describe is the sum of two scaled vectors. That's a concept, this idea of adding together two scaled vectors. Those two vectors I have",
    ts: 1000,
  };
  const leaked = { channel: 'you', text: 'Those two vectors I had', ts: 14000 };
  assert.ok(fuzzyShortFragmentOverlap(direct.text, leaked.text) >= 0.86);
  assert.equal(areCrossTalkDuplicates(direct, leaked), true);
  const match = findCrossTalkDuplicate([direct], leaked, new Map([[20, 1000]]), 14000);
  assert.equal(match.match, 'fuzzy_fragment');
});

test('short fuzzy echo matching expires and does not erase a later real response', () => {
  const direct = { id: 21, channel: 'them', text: 'Those two vectors I have', ts: 1000 };
  const repeatedLater = { channel: 'you', text: 'Those two vectors I had', ts: 17000 };
  assert.equal(findCrossTalkDuplicate([direct], repeatedLater, new Map([[21, 1000]]), 17000), null);
  assert.equal(fuzzyShortFragmentOverlap(
    'Could you explain the vector coordinates in this example?',
    'I understand the vector coordinates but have another question',
  ), 0);
});

test('rolling opposite-channel segments catch native system finals split differently from microphone echo', () => {
  const leakedMicSegments = [
    { id: 30, channel: 'you', text: 'The answer is that you can reach every possible two-dimensional vector', ts: 1000 },
    { id: 31, channel: 'you', text: 'and I think it is a good puzzle to contemplate why', ts: 4000 },
    { id: 32, channel: 'you', text: 'a new pair of basis vectors like this still gives us a valid way to go back and forth', ts: 7000 },
  ];
  const arrivals = new Map([[30, 1000], [31, 4000], [32, 7000]]);
  const directSystem = {
    channel: 'them',
    text: 'I think it is a good puzzle to contemplate why a new pair of basis vectors like this still gives us a valid way to go back and forth.',
  };
  const match = findCrossTalkDuplicate(leakedMicSegments, directSystem, arrivals, 9000);
  assert.ok(match);
  assert.deepEqual(match.turns.map((entry) => entry.id), [31, 32]);
});

test('authoritative Them finals remove a leaked You phrase spanning their boundary', () => {
  const segments = [
    { id: 40, channel: 'them', text: 'Luckily linear algebra limits itself to transformations that are easier to understand called', ts: 1000 },
    { id: 41, channel: 'you', text: 'to understand called linear transformations', ts: 2000 },
  ];
  const arrivals = new Map([[40, 1000], [41, 2000]]);
  const candidate = { channel: 'them', text: 'Linear transformations. Visually speaking, a transformation is linear if it has two properties.' };
  assert.equal(findCrossTalkDuplicate(segments, candidate, arrivals, 3000), null);
  const match = findCrossTalkDuplicateAcrossCandidateWindow(segments, candidate, arrivals, 3000);
  assert.ok(match);
  assert.deepEqual(match.turns.map((entry) => entry.id), [41]);
  assert.ok(['phrase_overlap', 'fuzzy_fragment'].includes(match.match));
});

test('authoritative boundary matching preserves unrelated real You speech', () => {
  const segments = [
    { id: 50, channel: 'them', text: 'The origin must remain fixed in place and all straight lines remain straight', ts: 1000 },
    { id: 51, channel: 'you', text: 'Could you explain why that restriction matters for rotations?', ts: 2000 },
  ];
  const arrivals = new Map([[50, 1000], [51, 2000]]);
  const candidate = { channel: 'them', text: 'For example, this transformation moves the basis vectors while keeping the origin fixed.' };
  assert.equal(findCrossTalkDuplicateAcrossCandidateWindow(segments, candidate, arrivals, 3000), null);
});
