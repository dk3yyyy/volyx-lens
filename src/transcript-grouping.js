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

function appendConversationSegment(turns, segment, createTurnId) {
  if (!Array.isArray(turns)) throw new TypeError('turns must be an array');
  const channel = segment && segment.channel === 'you' ? 'you' : 'them';
  const previousTurn = turns[turns.length - 1];
  const updated = !!previousTurn && previousTurn.channel === channel;
  const turn = updated
    ? previousTurn
    : { id: createTurnId(), channel, text: '', ts: segment.ts, segments: [] };
  if (!updated) turns.push(turn);
  segment.turnId = turn.id;
  turn.segments.push(segment);
  turn.text = joinTranscriptSegments(turn.segments);
  turn.ts = turn.segments[0].ts;
  return { turn, updated };
}

module.exports = { cleanSegmentText, appendSegmentText, joinTranscriptSegments, appendConversationSegment };
