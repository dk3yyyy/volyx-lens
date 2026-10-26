'use strict';

// Readable-transcript cleanup.
//
// The live transcript is verbatim speech-to-text: the recognizer's wording is
// what gets stored, exported, and shown. This module prepares an on-demand,
// identity-preserving repair pass over a SAVED meeting:
//
// - Turns keep their identity. The model is given numbered lines and must
//   return the same number of lines, in the same order, with the same markers.
//   Nothing is merged, split, dropped, reordered, or summarised, so the cleaned
//   copy stays a transcript rather than becoming a paraphrase of one.
// - The raw turns are never mutated. The cleaned copy lives beside them, and a
//   turn whose cleaned line is missing or suspicious falls back to raw text.
// - Only mechanical recognition damage is repaired: homophones, split or merged
//   words, casing of names, punctuation and capitalisation. Unintelligible
//   words are left as they arrived instead of being invented.
//
// Scope note: this runs only when the user asks for it, after a session is
// saved. It never touches the live capture path.

const CLEAN_BATCH_TURNS = 40;
const CLEAN_BATCH_CHARACTERS = 6000;
const MAX_CLEAN_BATCHES = 20;
const MIN_LENGTH_RATIO = 0.4;
const MAX_LENGTH_RATIO = 2.5;

const CLEAN_SYSTEM_PROMPT =
  'You repair speech-to-text output. You are not summarising, rewriting, or answering anything. ' +
  'The input is numbered transcript lines from a meeting, each already labelled with its speaker. ' +
  'Return exactly the same number of lines, in the same order, each starting with the same [n] marker and the same speaker label. ' +
  'Fix only mechanical recognition damage: words the recognizer misheard but that are obvious from context (homophones, split or merged words, the casing of names and product terms), missing sentence punctuation and capitalisation, and accidental stutters such as "the the". ' +
  'You must not add information, remove content, soften or shorten what was said, drop a line, merge two lines, split one line, or reorder anything. ' +
  'When a word is unintelligible and you cannot tell what was said, leave that word exactly as it arrived. ' +
  'Keep the speaker\'s register, including profanity and filler words. ' +
  'Output only the repaired lines. No preamble, no explanation, no code fences.';

function speakerLabel(channel) {
  return channel === 'you' ? 'You' : 'Them';
}

/**
 * Split saved turns into request-sized batches. Indices are GLOBAL positions in
 * the saved turn array, so a cleaned line can always be mapped back to the turn
 * it came from. No sampling: a dropped turn would be a silent hole in the
 * transcript, so an over-long meeting is reported instead.
 */
function planCleanBatches(turns, {
  turnLimit = CLEAN_BATCH_TURNS,
  charLimit = CLEAN_BATCH_CHARACTERS,
  maxBatches = MAX_CLEAN_BATCHES,
} = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const entries = [];
  for (let index = 0; index < list.length; index += 1) {
    const turn = list[index];
    const text = String((turn && turn.text) || '');
    if (!text.trim()) continue;
    entries.push({
      index,
      channel: turn && turn.channel === 'you' ? 'you' : 'them',
      text,
      line: `[${index}] ${speakerLabel(turn && turn.channel)}: ${text}`,
    });
  }

  const sourceCharacters = entries.reduce((total, entry) => total + entry.text.length, 0);
  const batches = [];
  let current = null;
  for (const entry of entries) {
    if (!current) current = { entries: [], text: '' };
    const addition = (current.entries.length ? 1 : 0) + entry.line.length;
    const overTurns = current.entries.length >= turnLimit;
    const overCharacters = current.entries.length > 0 && current.text.length + addition > charLimit;
    if (overTurns || overCharacters) {
      batches.push(current);
      current = { entries: [], text: '' };
    }
    current.entries.push(entry);
    current.text = current.text ? `${current.text}\n${entry.line}` : entry.line;
  }
  if (current && current.entries.length) batches.push(current);

  if (batches.length > maxBatches) {
    return { tooLong: true, requestCount: batches.length, batches: [], sourceCharacters, maxBatches };
  }

  return {
    tooLong: false,
    sourceCharacters,
    maxBatches,
    requestCount: batches.length,
    batches: batches.map((batch) => ({
      indices: batch.entries.map((entry) => entry.index),
      text: batch.text,
      entries: batch.entries,
    })),
  };
}

function buildCleanPrompt(batch) {
  const text = String((batch && batch.text) || '');
  return (
    'Repair these transcript lines for readability. Same line count, same order, same [n] markers.\n\n' +
    text
  );
}

/**
 * Parse a model reply back into cleaned per-turn text.
 *
 * Accepted: a marker that was actually sent, non-empty text, and a length close
 * enough to the raw turn that the line is a repair rather than a rewrite.
 * Rejected or missing lines are simply absent from `accepted`, so the caller
 * keeps the raw wording for those turns.
 */
function parseCleanBatch(reply, batch) {
  const entries = (batch && Array.isArray(batch.entries)) ? batch.entries : [];
  const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
  const accepted = new Map();
  const rejected = [];

  const lines = String(reply || '').replace(/```[a-z]*\n?/gi, '').split(/\r?\n/);
  for (const rawLine of lines) {
    const match = rawLine.match(/^\s*\[(\d+)\]\s*(?:(you|them)\s*:\s*)?(.*)$/i);
    if (!match) continue;
    const index = Number(match[1]);
    const entry = byIndex.get(index);
    if (!entry) continue;
    const text = String(match[3] || '').trim();
    if (!text) continue;
    if (accepted.has(index)) continue;
    const rawLength = entry.text.trim().length;
    const cleanedLength = text.length;
    if (rawLength > 0 && (cleanedLength < rawLength * MIN_LENGTH_RATIO || cleanedLength > rawLength * MAX_LENGTH_RATIO)) {
      rejected.push({
        index,
        reason: `length guard: ${cleanedLength} chars for a ${rawLength}-char turn`,
      });
      continue;
    }
    accepted.set(index, text);
  }

  const missing = entries
    .map((entry) => entry.index)
    .filter((index) => !accepted.has(index) && !rejected.some((item) => item.index === index));

  return { accepted, rejected, missing };
}

/**
 * Build the parallel cleaned turn array: same length, same speakers, same
 * timestamps, cleaned text where a line was accepted and raw text otherwise.
 */
function cleanedTurnsFrom(turns, accepted) {
  const map = accepted instanceof Map ? accepted : new Map(Object.entries(accepted || {}).map(([key, value]) => [Number(key), value]));
  return (Array.isArray(turns) ? turns : []).map((turn, index) => {
    const cleaned = map.get(index);
    const text = typeof cleaned === 'string' && cleaned.trim() ? cleaned.trim() : String((turn && turn.text) || '');
    return {
      channel: turn && turn.channel === 'you' ? 'you' : 'them',
      text,
      ts: Number.isFinite(turn && turn.ts) ? turn.ts : undefined,
    };
  });
}

module.exports = {
  CLEAN_BATCH_TURNS,
  CLEAN_BATCH_CHARACTERS,
  MAX_CLEAN_BATCHES,
  MIN_LENGTH_RATIO,
  MAX_LENGTH_RATIO,
  CLEAN_SYSTEM_PROMPT,
  planCleanBatches,
  buildCleanPrompt,
  parseCleanBatch,
  cleanedTurnsFrom,
};
