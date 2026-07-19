const DEFAULT_WINDOW_MS = 8000;
const MIN_TOKENS = 5;
const MIN_CHARACTERS = 24;
const MIN_LENGTH_RATIO = 0.65;
const MIN_SIMILARITY = 0.82;

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
  return speechSimilarity(left.text, right.text) >= MIN_SIMILARITY;
}

function findCrossTalkDuplicate(turns, candidate, arrivalTimes, now = Date.now(), windowMs = DEFAULT_WINDOW_MS) {
  let best = null;
  for (let index = turns.length - 1; index >= 0 && index >= turns.length - 20; index -= 1) {
    const turn = turns[index];
    if (!turn || turn.channel === candidate.channel) continue;
    const arrivedAt = arrivalTimes instanceof Map ? arrivalTimes.get(turn.id) : turn.ts;
    if (!Number.isFinite(arrivedAt) || Math.abs(now - arrivedAt) > windowMs) continue;
    const similarity = speechSimilarity(turn.text, candidate.text);
    if (similarity >= MIN_SIMILARITY && (!best || similarity > best.similarity)) best = { turn, index, similarity };
  }
  return best;
}

module.exports = {
  DEFAULT_WINDOW_MS,
  MIN_TOKENS,
  MIN_CHARACTERS,
  MIN_LENGTH_RATIO,
  MIN_SIMILARITY,
  normalizeSpeech,
  speechSimilarity,
  areCrossTalkDuplicates,
  findCrossTalkDuplicate,
};
