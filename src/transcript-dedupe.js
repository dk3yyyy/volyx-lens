const DEFAULT_WINDOW_MS = 15000;
const MIN_TOKENS = 5;
const MIN_CHARACTERS = 24;
const MIN_LENGTH_RATIO = 0.65;
const MIN_SIMILARITY = 0.82;
const MIN_PHRASE_TOKENS = 4;
const MIN_PHRASE_CHARACTERS = 20;
const MIN_PHRASE_COVERAGE = 0.5;
const MIN_FUZZY_FRAGMENT_TOKENS = 4;
const MAX_FUZZY_FRAGMENT_TOKENS = 8;
const MIN_FUZZY_FRAGMENT_CHARACTERS = 18;
const MIN_FUZZY_FRAGMENT_SIMILARITY = 0.86;

function normalizeSpeech(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenDice(leftTokens, rightTokens) {
  const remaining = new Map();
  for (const token of leftTokens) remaining.set(token, (remaining.get(token) || 0) + 1);
  let overlap = 0;
  for (const token of rightTokens) {
    const count = remaining.get(token) || 0;
    if (!count) continue;
    overlap += 1;
    if (count === 1) remaining.delete(token);
    else remaining.set(token, count - 1);
  }
  return (2 * overlap) / (leftTokens.length + rightTokens.length);
}

function longestContiguousTokenOverlap(leftTokens, rightTokens) {
  let bestLength = 0;
  let bestEnd = 0;
  let previous = new Uint16Array(rightTokens.length + 1);
  for (let leftIndex = 1; leftIndex <= leftTokens.length; leftIndex += 1) {
    const current = new Uint16Array(rightTokens.length + 1);
    for (let rightIndex = 1; rightIndex <= rightTokens.length; rightIndex += 1) {
      if (leftTokens[leftIndex - 1] !== rightTokens[rightIndex - 1]) continue;
      current[rightIndex] = previous[rightIndex - 1] + 1;
      if (current[rightIndex] > bestLength) {
        bestLength = current[rightIndex];
        bestEnd = leftIndex;
      }
    }
    previous = current;
  }
  return leftTokens.slice(bestEnd - bestLength, bestEnd);
}

function substantialPhraseOverlap(left, right) {
  const normalizedLeft = normalizeSpeech(left);
  const normalizedRight = normalizeSpeech(right);
  const leftTokens = normalizedLeft ? normalizedLeft.split(' ') : [];
  const rightTokens = normalizedRight ? normalizedRight.split(' ') : [];
  if (!leftTokens.length || !rightTokens.length) return 0;
  const phrase = longestContiguousTokenOverlap(leftTokens, rightTokens);
  const phraseCharacters = phrase.join(' ').length;
  const coverage = phrase.length / Math.min(leftTokens.length, rightTokens.length);
  if (
    phrase.length < MIN_PHRASE_TOKENS ||
    phraseCharacters < MIN_PHRASE_CHARACTERS ||
    coverage < MIN_PHRASE_COVERAGE
  ) return 0;
  return coverage;
}

function editSimilarity(left, right) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  let previous = new Uint16Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) previous[index] = index;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Uint16Array(right.length + 1);
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(previous[rightIndex] + 1, current[rightIndex - 1] + 1, substitution);
    }
    previous = current;
  }
  return 1 - (previous[right.length] / Math.max(left.length, right.length));
}

function fuzzyShortFragmentOverlap(left, right) {
  const normalizedLeft = normalizeSpeech(left);
  const normalizedRight = normalizeSpeech(right);
  const leftTokens = normalizedLeft ? normalizedLeft.split(' ') : [];
  const rightTokens = normalizedRight ? normalizedRight.split(' ') : [];
  const fragmentTokens = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const sourceTokens = fragmentTokens === leftTokens ? rightTokens : leftTokens;
  const fragment = fragmentTokens.join(' ');
  if (
    fragmentTokens.length < MIN_FUZZY_FRAGMENT_TOKENS ||
    fragmentTokens.length > MAX_FUZZY_FRAGMENT_TOKENS ||
    fragment.length < MIN_FUZZY_FRAGMENT_CHARACTERS
  ) return 0;
  let best = 0;
  for (const width of [fragmentTokens.length - 1, fragmentTokens.length, fragmentTokens.length + 1]) {
    if (width < MIN_FUZZY_FRAGMENT_TOKENS || width > sourceTokens.length) continue;
    for (let start = 0; start <= sourceTokens.length - width; start += 1) {
      best = Math.max(best, editSimilarity(fragment, sourceTokens.slice(start, start + width).join(' ')));
    }
  }
  return best >= MIN_FUZZY_FRAGMENT_SIMILARITY ? best : 0;
}

function speechSimilarity(left, right) {
  const normalizedLeft = normalizeSpeech(left);
  const normalizedRight = normalizeSpeech(right);
  const leftTokens = normalizedLeft ? normalizedLeft.split(' ') : [];
  const rightTokens = normalizedRight ? normalizedRight.split(' ') : [];
  if (
    Math.min(normalizedLeft.length, normalizedRight.length) < MIN_CHARACTERS ||
    Math.min(leftTokens.length, rightTokens.length) < MIN_TOKENS
  ) return 0;
  const lengthRatio = Math.min(leftTokens.length, rightTokens.length) / Math.max(leftTokens.length, rightTokens.length);
  if (lengthRatio < MIN_LENGTH_RATIO) return 0;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 1;
  return tokenDice(leftTokens, rightTokens);
}

function areCrossTalkDuplicates(left, right) {
  if (!left || !right || left.channel === right.channel) return false;
  if (!['you', 'them'].includes(left.channel) || !['you', 'them'].includes(right.channel)) return false;
  return speechSimilarity(left.text, right.text) >= MIN_SIMILARITY
    || substantialPhraseOverlap(left.text, right.text) > 0
    || fuzzyShortFragmentOverlap(left.text, right.text) > 0;
}

function findCrossTalkDuplicate(turns, candidate, arrivalTimes, now = Date.now(), windowMs = DEFAULT_WINDOW_MS) {
  let best = null;
  for (let index = turns.length - 1; index >= 0 && index >= turns.length - 20; index -= 1) {
    const turn = turns[index];
    if (!turn || turn.channel === candidate.channel) continue;
    const arrivedAt = arrivalTimes instanceof Map ? arrivalTimes.get(turn.id) : turn.ts;
    if (!Number.isFinite(arrivedAt) || Math.abs(now - arrivedAt) > windowMs) continue;
    const similarity = speechSimilarity(turn.text, candidate.text);
    const phraseOverlap = substantialPhraseOverlap(turn.text, candidate.text);
    const fuzzyOverlap = fuzzyShortFragmentOverlap(turn.text, candidate.text);
    const score = Math.max(similarity, phraseOverlap, fuzzyOverlap);
    if ((similarity >= MIN_SIMILARITY || phraseOverlap > 0 || fuzzyOverlap > 0) && (!best || score > best.similarity)) {
      const match = similarity >= MIN_SIMILARITY ? 'similarity' : (phraseOverlap > 0 ? 'phrase_overlap' : 'fuzzy_fragment');
      best = { turn, index, similarity: score, match };
    }
  }
  return best;
}

module.exports = {
  DEFAULT_WINDOW_MS,
  MIN_TOKENS,
  MIN_CHARACTERS,
  MIN_LENGTH_RATIO,
  MIN_SIMILARITY,
  MIN_PHRASE_TOKENS,
  MIN_PHRASE_CHARACTERS,
  MIN_PHRASE_COVERAGE,
  MIN_FUZZY_FRAGMENT_TOKENS,
  MAX_FUZZY_FRAGMENT_TOKENS,
  MIN_FUZZY_FRAGMENT_CHARACTERS,
  MIN_FUZZY_FRAGMENT_SIMILARITY,
  normalizeSpeech,
  speechSimilarity,
  longestContiguousTokenOverlap,
  substantialPhraseOverlap,
  editSimilarity,
  fuzzyShortFragmentOverlap,
  areCrossTalkDuplicates,
  findCrossTalkDuplicate,
};
