function cleanSegmentText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function appendSegmentText(current, next) {
  const left = cleanSegmentText(current);
  const right = cleanSegmentText(next);
  if (!left) return right;
  if (!right) return left;
  const startsWithClosingPunctuation = /^[,.;:!?%)}\]]/.test(right);
  const leftNeedsNoSpace = /[\s([{\-–—/]$/.test(left);
  return `${left}${startsWithClosingPunctuation || leftNeedsNoSpace ? '' : ' '}${right}`;
}

function joinTranscriptSegments(segments) {
  return (Array.isArray(segments) ? segments : []).reduce(
    (text, segment) => appendSegmentText(text, segment && Object.hasOwn(segment, 'text') ? segment.text : segment),
    '',
  );
}

function joinRawTranscriptSegments(segments) {
  return (Array.isArray(segments) ? segments : []).reduce(
    (text, segment) => appendSegmentText(text, segment && typeof segment.rawText === 'string' ? segment.rawText : (segment && segment.text)),
    '',
  );
}

function refreshConversationTurn(turn) {
  turn.text = joinTranscriptSegments(turn.segments);
  const rawText = joinRawTranscriptSegments(turn.segments);
  if (rawText && rawText !== turn.text) turn.rawText = rawText;
  else delete turn.rawText;
  turn.ts = turn.segments[0].ts;
}

function appendConversationSegment(turns, segment, createTurnId, beforeTurn = null) {
  if (!Array.isArray(turns)) throw new TypeError('turns must be an array');
  const channel = segment && segment.channel === 'you' ? 'you' : 'them';
  const previousTurn = turns[turns.length - 1];
  let turn = beforeTurn;
  let insertIndex = turns.length;
  if (turn) {
    insertIndex = turns.indexOf(turn);
    if (insertIndex < 0 || turn.channel !== channel) turn = null;
  }
  const updated = !!turn && turn.channel === channel || !turn && !!previousTurn && previousTurn.channel === channel;
  if (!turn) turn = updated ? previousTurn : { id: createTurnId(), channel, text: '', ts: segment.ts, segments: [] };
  if (!updated) {
    if (insertIndex < turns.length) turns.splice(insertIndex, 0, turn);
    else turns.push(turn);
  }
  segment.turnId = turn.id;
  turn.segments.push(segment);
  refreshConversationTurn(turn);
  return { turn, updated };
}

// A restored line keeps its original timestamp rather than becoming the newest
// turn. Use the same grouping path as a live final, but choose the adjacent
// same-speaker turn at that point in time and then order its raw segments.
function insertConversationSegment(turns, segment, createTurnId) {
  if (!Array.isArray(turns)) throw new TypeError('turns must be an array');
  const channel = segment && segment.channel === 'you' ? 'you' : 'them';
  const timestamp = Number.isFinite(segment && segment.ts) ? segment.ts : Date.now();
  segment.ts = timestamp;
  const nextIndex = turns.findIndex((turn) => {
    const segments = Array.isArray(turn.segments) ? turn.segments : [];
    return segments.length ? segments[segments.length - 1].ts >= timestamp : turn.ts >= timestamp;
  });
  const nextTurn = nextIndex >= 0 ? turns[nextIndex] : null;
  const previousTurn = nextIndex > 0 ? turns[nextIndex - 1] : nextIndex < 0 ? turns[turns.length - 1] : null;
  const target = nextTurn && nextTurn.channel === channel
    ? nextTurn
    : previousTurn && previousTurn.channel === channel ? previousTurn : null;
  const result = appendConversationSegment(turns, segment, createTurnId, target || nextTurn);
  if (target) {
    target.segments.sort((left, right) => left.ts - right.ts);
    refreshConversationTurn(target);
  }
  return result;
}

module.exports = { cleanSegmentText, appendSegmentText, joinTranscriptSegments, joinRawTranscriptSegments, appendConversationSegment, insertConversationSegment };
