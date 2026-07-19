const DEFAULT_MAX_LINES = 300;
const MIN_OVERLAP_LINES = 4;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'explain', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'or',
  'please', 'should', 'that', 'the', 'this', 'to', 'what', 'when', 'where', 'which',
  'why', 'with', 'would', 'you', 'your',
]);

function parseLine(raw, index) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const numbered = trimmed.match(/^(\d{1,6})\s*(?:[|:])?\s+(.+)$/);
  const content = numbered ? numbered[2] : trimmed;
  const normalized = content
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const tokens = normalized.match(/[a-z_$][a-z0-9_$]*|\d+(?:\.\d+)?|===|!==|=>|==|!=|<=|>=|&&|\|\||[{}()[\].,;:+*/%<>=!?&|~-]/g) || [];
  return {
    raw: trimmed,
    normalized,
    tokens,
    sourceIndex: index,
    lineNumber: numbered ? Number(numbered[1]) : null,
    substantive: /[a-z0-9_$]{2,}/i.test(normalized),
  };
}

function parseOcrLines(text, maxLines = DEFAULT_MAX_LINES) {
  const parsed = String(text || '').split(/\r?\n/).map(parseLine).filter(Boolean);
  if (parsed.length <= maxLines) return parsed;
  const head = Math.floor(maxLines / 2);
  return [...parsed.slice(0, head), ...parsed.slice(-(maxLines - head))];
}

function tokenDice(left, right) {
  if (!left.length || !right.length) return 0;
  const counts = new Map();
  for (const token of left) counts.set(token, (counts.get(token) || 0) + 1);
  let shared = 0;
  for (const token of right) {
    const count = counts.get(token) || 0;
    if (!count) continue;
    shared += 1;
    counts.set(token, count - 1);
  }
  return (2 * shared) / (left.length + right.length);
}

function lineSimilarity(left, right) {
  if (left.normalized === right.normalized) return 1;
  const lengthRatio = Math.min(left.normalized.length, right.normalized.length) / Math.max(left.normalized.length, right.normalized.length);
  if (lengthRatio < 0.72 || Math.min(left.normalized.length, right.normalized.length) < 6) return 0;
  return tokenDice(left.tokens, right.tokens);
}

function numberedRange(left, right, startLeft, startRight, length) {
  const numbers = [];
  for (let offset = 0; offset < length; offset += 1) {
    const a = left[startLeft + offset].lineNumber;
    const b = right[startRight + offset].lineNumber;
    if (Number.isSafeInteger(a) && Number.isSafeInteger(b) && Math.abs(a - b) <= 1) numbers.push(Math.round((a + b) / 2));
  }
  if (numbers.length < Math.max(3, Math.floor(length * 0.6))) return { lineStart: null, lineEnd: null };
  for (let index = 1; index < numbers.length; index += 1) {
    if (numbers[index] < numbers[index - 1] || numbers[index] - numbers[index - 1] > 2) return { lineStart: null, lineEnd: null };
  }
  return { lineStart: numbers[0], lineEnd: numbers[numbers.length - 1] };
}

function detectTextOverlap(earlierText, laterText, { maxLines = DEFAULT_MAX_LINES, minLines = MIN_OVERLAP_LINES } = {}) {
  const earlier = parseOcrLines(earlierText, maxLines);
  const later = parseOcrLines(laterText, maxLines);
  if (earlier.length < minLines || later.length < minLines) return null;

  let previous = new Array(later.length + 1).fill(null).map(() => ({ length: 0, similarity: 0 }));
  let best = null;
  for (let leftIndex = 0; leftIndex < earlier.length; leftIndex += 1) {
    const current = new Array(later.length + 1).fill(null).map(() => ({ length: 0, similarity: 0 }));
    for (let rightIndex = 0; rightIndex < later.length; rightIndex += 1) {
      const similarity = lineSimilarity(earlier[leftIndex], later[rightIndex]);
      if (similarity < 0.9) continue;
      const prior = previous[rightIndex];
      const length = prior.length + 1;
      const similarityTotal = prior.similarity + similarity;
      current[rightIndex + 1] = { length, similarity: similarityTotal };
      if (length < minLines) continue;
      const startLeft = leftIndex - length + 1;
      const startRight = rightIndex - length + 1;
      if (leftIndex < Math.floor(earlier.length * 0.6) || startRight > Math.ceil(later.length * 0.4)) continue;
      const segment = earlier.slice(startLeft, leftIndex + 1);
      const substantive = segment.filter((line) => line.substantive).length;
      const distinct = new Set(segment.filter((line) => line.substantive).map((line) => line.normalized)).size;
      if (substantive < minLines || distinct < 3) continue;
      const averageSimilarity = similarityTotal / length;
      const candidate = { startLeft, endLeft: leftIndex, startRight, endRight: rightIndex, length, substantive, averageSimilarity };
      if (!best || candidate.substantive > best.substantive
        || (candidate.substantive === best.substantive && candidate.averageSimilarity > best.averageSimilarity)
        || (candidate.substantive === best.substantive && candidate.averageSimilarity === best.averageSimilarity && candidate.length > best.length)) best = candidate;
    }
    previous = current;
  }
  if (!best) return null;

  const range = numberedRange(earlier, later, best.startLeft, best.startRight, best.length);
  const overlapLines = range.lineStart !== null ? range.lineEnd - range.lineStart + 1 : best.length;
  const uniqueLater = later.filter((_, index) => index < best.startRight || index > best.endRight).map((line) => line.raw).join('\n');
  return {
    overlapLines,
    confidence: Math.round(best.averageSimilarity * 100),
    lineStart: range.lineStart,
    lineEnd: range.lineEnd,
    earlierStart: best.startLeft,
    earlierEnd: best.endLeft,
    laterStart: best.startRight,
    laterEnd: best.endRight,
    uniqueLaterText: uniqueLater,
  };
}

function queryTokens(value) {
  return [...new Set((String(value || '').toLowerCase().match(/[a-z_$][a-z0-9_$]*|\d+/g) || [])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token)))];
}

function visibleLineNumbers(text) {
  const values = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const match = raw.trim().match(/^(\d{1,6})\s*(?:[|:])?\s+\S/);
    if (match) values.push(Number(match[1]));
  }
  return values;
}

function scoreTextRelevance(query, uniqueText, fullText = uniqueText) {
  const wanted = queryTokens(query);
  if (!wanted.length || !String(fullText || '').trim()) return 0;
  const normalizedUnique = String(uniqueText || '').toLowerCase();
  const normalizedFull = String(fullText || '').toLowerCase();
  let score = 0;
  for (const token of wanted) {
    const weight = token.length >= 8 ? 5 : token.length >= 5 ? 3 : 1;
    if (normalizedUnique.includes(token)) score += weight * 4;
    else if (normalizedFull.includes(token)) score += weight;
  }
  for (let index = 0; index < wanted.length - 1; index += 1) {
    const phrase = `${wanted[index]} ${wanted[index + 1]}`;
    if (normalizedUnique.includes(phrase)) score += 8;
    else if (normalizedFull.includes(phrase)) score += 2;
  }
  const targetLines = [...String(query || '').matchAll(/\blines?\s+(\d{1,6})(?:\s*[-–]\s*(\d{1,6}))?/gi)]
    .flatMap((match) => match[2] ? [Number(match[1]), Number(match[2])] : [Number(match[1])]);
  if (targetLines.length) {
    const uniqueShown = visibleLineNumbers(uniqueText);
    const fullShown = visibleLineNumbers(fullText);
    const scoreRange = (shown, line, base) => {
      if (!shown.length) return 0;
      const minimum = Math.min(...shown);
      const maximum = Math.max(...shown);
      if (line < minimum || line > maximum) return 0;
      const center = (minimum + maximum) / 2;
      const span = Math.max(1, maximum - minimum);
      return base + Math.round((base / 3) * (1 - Math.min(1, Math.abs(line - center) / span)));
    };
    for (const line of targetLines) {
      const uniqueBonus = scoreRange(uniqueShown, line, 30);
      score += uniqueBonus || scoreRange(fullShown, line, 5);
    }
  }
  return score;
}

module.exports = {
  DEFAULT_MAX_LINES,
  MIN_OVERLAP_LINES,
  parseOcrLines,
  lineSimilarity,
  detectTextOverlap,
  scoreTextRelevance,
};
