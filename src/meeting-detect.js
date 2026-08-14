'use strict';

// In-session meeting detection. This runs only while the user is actively
// listening, consumes only finalized in-memory turns, and never watches audio,
// touches disk, or calls a model — so there is no background watcher and no
// surprise usage cost. Opt-in via the `transcription.meetingDetection` setting.
//
// Heuristic: a "meeting" is a sustained two-sided conversation. Within a
// rolling time window both the user and the other side must have contributed a
// minimum number of finalized turns, the conversation must have alternated
// between the two channels a minimum number of times, and the windowed activity
// must span a minimum duration before the session is classified as a meeting.

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MIN_TURNS_PER_SIDE = 3;
const DEFAULT_MIN_FLIPS = 2;
const DEFAULT_MIN_SPAN_MS = 30 * 1000;

function countFlips(turns) {
  let flips = 0;
  for (let i = 1; i < turns.length; i += 1) {
    if (turns[i].channel !== turns[i - 1].channel) flips += 1;
  }
  return flips;
}

function createMeetingDetector({
  windowMs = DEFAULT_WINDOW_MS,
  minTurnsPerSide = DEFAULT_MIN_TURNS_PER_SIDE,
  minFlips = DEFAULT_MIN_FLIPS,
  minSpanMs = DEFAULT_MIN_SPAN_MS,
  now = () => Date.now(),
} = {}) {
  const turns = [];
  let meeting = false;
  let detectedSince = null;

  function snapshot() {
    return {
      meeting,
      detectedSince,
      youTurns: turns.filter((turn) => turn.channel === 'you').length,
      themTurns: turns.filter((turn) => turn.channel === 'them').length,
      flips: countFlips(turns),
      windowTurns: turns.length,
    };
  }

  function add(turn) {
    if (!turn || typeof turn !== 'object') return snapshot();
    const channel = turn.channel === 'you' ? 'you' : 'them';
    if (!String(turn.text || '').trim()) return snapshot();
    const ts = Number.isFinite(turn.ts) ? turn.ts : now();
    turns.push({ channel, ts });
    const cutoff = ts - windowMs;
    while (turns.length && turns[0].ts < cutoff) turns.shift();
    if (!meeting) {
      const youTurns = turns.filter((turn) => turn.channel === 'you').length;
      const themTurns = turns.filter((turn) => turn.channel === 'them').length;
      const flips = countFlips(turns);
      const span = turns.length ? turns[turns.length - 1].ts - turns[0].ts : 0;
      if (youTurns >= minTurnsPerSide && themTurns >= minTurnsPerSide && flips >= minFlips && span >= minSpanMs) {
        meeting = true;
        detectedSince = ts;
      }
    }
    return snapshot();
  }

  function reset() {
    turns.length = 0;
    meeting = false;
    detectedSince = null;
    return snapshot();
  }

  return { add, snapshot, reset };
}

module.exports = { createMeetingDetector, DEFAULT_WINDOW_MS, DEFAULT_MIN_TURNS_PER_SIDE, DEFAULT_MIN_FLIPS, DEFAULT_MIN_SPAN_MS };