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
// turn. Insert at the first later segment, splitting a surrounding turn when
// necessary so grouped speech does not jump ahead of the restored answer.
function insertConversationSegment(turns, segment, createTurnId) {
  if (!Array.isArray(turns)) throw new TypeError('turns must be an array');
  const channel = segment && segment.channel === 'you' ? 'you' : 'them';
  const timestamp = Number.isFinite(segment && segment.ts) ? segment.ts : Date.now();
  segment.ts = timestamp;

  let location = null;
  for (let turnIndex = 0; turnIndex < turns.length && !location; turnIndex += 1) {
    const segments = Array.isArray(turns[turnIndex].segments) ? turns[turnIndex].segments : [];
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      if (segments[segmentIndex].ts > timestamp) {
        location = { turnIndex, segmentIndex };
        break;
      }
    }
  }

  const remapped = [];
  const makeTurn = () => ({
    id: createTurnId(), channel, text: '', ts: timestamp, segments: [],
  });

  if (!location) {
    const previousTurn = turns[turns.length - 1];
    if (previousTurn && previousTurn.channel === channel) {
      return appendConversationSegment(turns, segment, createTurnId);
    }
    const turn = makeTurn();
    segment.turnId = turn.id;
    turn.segments.push(segment);
    refreshConversationTurn(turn);
    turns.push(turn);
    return { turn, updated: false, remapped };
  }

  const { turnIndex, segmentIndex } = location;
  const surrounding = turns[turnIndex];
  const segments = Array.isArray(surrounding.segments) ? surrounding.segments : [];
  if (surrounding.channel === channel) {
    surrounding.segments.push(segment);
    segment.turnId = surrounding.id;
    surrounding.segments.sort((left, right) => left.ts - right.ts);
    refreshConversationTurn(surrounding);
    return { turn: surrounding, updated: true, remapped };
  }

  if (segmentIndex > 0 && surrounding.channel !== channel) {
    const prefix = surrounding.segments.slice(0, segmentIndex);
    const suffix = surrounding.segments.slice(segmentIndex);
    const suffixTurn = {
      id: createTurnId(), channel: surrounding.channel, text: '', ts: suffix[0].ts, segments: suffix,
    };
    surrounding.segments = prefix;
    refreshConversationTurn(surrounding);
    for (const entry of suffix) entry.turnId = suffixTurn.id;
    refreshConversationTurn(suffixTurn);
    remapped.push({ oldTurnId: surrounding.id, newTurnId: suffixTurn.id, segments: suffix });

    const restored = makeTurn();
    segment.turnId = restored.id;
    restored.segments.push(segment);
    refreshConversationTurn(restored);
    turns.splice(turnIndex + 1, 0, restored, suffixTurn);
    return { turn: restored, updated: false, remapped };
  }

  const restored = makeTurn();
  segment.turnId = restored.id;
  restored.segments.push(segment);
  refreshConversationTurn(restored);
  turns.splice(turnIndex, 0, restored);
  return { turn: restored, updated: false, remapped };
}

module.exports = { cleanSegmentText, appendSegmentText, joinTranscriptSegments, joinRawTranscriptSegments, appendConversationSegment, insertConversationSegment };
