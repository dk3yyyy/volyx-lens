'use strict';

// Readable-transcript cleanup.
//
// The live transcript is verbatim speech-to-text: the recognizer's wording is
// what gets stored, exported, and shown. This module prepares an on-demand,
// identity-preserving repair pass over a SAVED meeting:
//
// - Turns keep their identity. The model is given numbered lines and must
//   return every marker exactly once, in ascending order. Nothing is merged,
//   split, dropped, reordered, or summarised, so the cleaned copy stays a
//   transcript rather than becoming a paraphrase of one.
// - The raw turns are never mutated. The cleaned copy lives beside them, and a
//   turn whose cleaned line is missing or suspicious keeps its raw wording.
// - Only mechanical recognition damage is repaired: homophones, split or merged
//   words, casing of names, punctuation and capitalisation. Unintelligible
//   words are left as they arrived instead of being invented.
// - A batch whose markers do not line up exactly is thrown away whole. Partial
//   trust in a misaligned batch is how text ends up under the wrong speaker.
//
// Scope note: this runs only when the user asks for it, after a session is
// saved. It never touches the live capture path.

const CLEAN_BATCH_TURNS = 100;
const CLEAN_BATCH_CHARACTERS = 6000;
const MAX_CLEAN_BATCHES = 30;

// Turns this short carry too little signal for a length-based fidelity check,
// so they are never rewritten.
const MIN_SHORT_TURN_CHARS = 12;

// A repair may collapse filler ("that that that" -> "that") and may add
// punctuation, so the lower bound is measured against the turn with repeated
// adjacent words already collapsed. The upper bound guards against invention.
const MIN_LOWER_RATIO = 0.4;
const MAX_UPPER_RATIO = 2;
const MIN_CLEANED_CHARACTERS = 8;

const NEGATION_PATTERN = /\b(?:not|no|never|none|cannot|without)\b|n't/gi;

const CLEAN_SYSTEM_PROMPT =
  'You repair speech-to-text output. You are not summarising, rewriting, or answering anything. ' +
  'The input is numbered transcript lines from a meeting, each already labelled with its speaker. ' +
  'Return exactly the same number of lines, in the same order, each starting with the same [n] marker and the same speaker label. ' +
  'Fix only mechanical recognition damage: words the recognizer misheard but that are obvious from context (homophones, split or merged words, the casing of names and product terms), missing sentence punctuation and capitalisation, and accidental stutters such as "the the". ' +
  'You must not add information, remove content, soften or shorten what was said, drop a line, merge two lines, split one line, or reorder anything. ' +
  'Never turn a spoken number into digits and never turn a digit into words; keep numbers exactly as they arrived. ' +
  'Never change a negation: if the speaker said not, keep not. ' +
  'When a word is unintelligible and you cannot tell what was said, leave that word exactly as it arrived. ' +
  'Keep the speaker\'s register, including profanity and filler words. ' +
  'Output only the repaired lines. No preamble, no explanation, no code fences.';

function speakerLabel(channel) {
  return channel === 'you' ? 'You' : 'Them';
}

/** Collapse runs of the same adjacent word, case-insensitively: "the the the" -> "the". */
function collapseRepeatedTokens(text) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  const kept = [];
  for (const token of tokens) {
    const strip = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const previous = kept[kept.length - 1];
    if (previous && strip(previous) && strip(previous) === strip(token)) continue;
    kept.push(token);
  }
  return kept.join(' ');
}

/**
 * Split saved turns into request-sized batches. Indices are GLOBAL positions in
 * the saved turn array, so a cleaned line can always be mapped back to the turn
 * it came from. No sampling: a dropped turn would be a silent hole in the
 * transcript, so an over-long meeting is refused rather than sampled.
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
    return {
      tooLong: true,
      requestCount: batches.length,
      batches: [],
      sourceCharacters,
      turnsCovered: 0,
      totalTurns: entries.length,
      maxBatches,
    };
  }

  return {
    tooLong: false,
    sourceCharacters,
    maxBatches,
    turnsCovered: entries.length,
    totalTurns: entries.length,
    requestCount: batches.length,
    batches: batches.map((batch) => ({
      indices: batch.entries.map((entry) => entry.index),
      text: batch.text,
      entries: batch.entries,
      // A repair pass echoes the input, so the output budget tracks the batch
      // size. The shared 700/1400 default truncates anything but tiny batches.
      maxTokens: Math.ceil(batch.text.length / 3) + 300,
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
 * Fidelity guards. A length check cannot catch a fluent rewrite or a flipped
 * negation, so the facts a repair must not change are checked directly:
 * numbers stay numbers, and the number of negations cannot change.
 */
/**
 * Standalone digit runs with separators stripped, so 1,000 and 1000 compare
 * equal while a model id such as V4 or 2FA is not mistaken for a quantity.
 */
function numericRuns(text) {
  const runs = String(text || '').match(/(?<![\p{L}\d])\d[\d,.:/-]*\d(?![\p{L}])|(?<![\p{L}\d])\d(?![\p{L}])/gu) || [];
  return runs.map((run) => run.replace(/\D/g, ''));
}

function fidelityIssue(raw, cleaned) {
  const source = String(raw || '');
  const result = String(cleaned || '');
  const rawNegations = (source.match(NEGATION_PATTERN) || []).length;
  const cleanedNegations = (result.match(NEGATION_PATTERN) || []).length;
  if (cleanedNegations !== rawNegations) return `negation count changed (${rawNegations} -> ${cleanedNegations})`;
  // Complete values, not substrings: "100" is contained in "1000", so a
  // substring check would wave through a changed amount.
  const rawRuns = numericRuns(source).sort();
  const cleanedRuns = numericRuns(result).sort();
  const same = rawRuns.length === cleanedRuns.length && rawRuns.every((run, index) => run === cleanedRuns[index]);
  if (!same) return `numbers changed (${rawRuns.join(', ') || 'none'} -> ${cleanedRuns.join(', ') || 'none'})`;
  return null;
}

/**
 * Parse a model reply back into cleaned per-turn text.
 *
 * The marker set must match the batch exactly, once each and ascending;
 * anything else fails the whole batch, because a misaligned batch silently
 * moves words under the wrong speaker and timecode. Within a well-formed batch,
 * a single turn that fails a guard keeps its raw wording.
 */
function parseCleanBatch(reply, batch) {
  const entries = (batch && Array.isArray(batch.entries)) ? batch.entries : [];
  const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
  const expected = entries.map((entry) => entry.index);
  const accepted = new Map();
  const rejected = [];

  const lines = String(reply || '').replace(/```[a-z]*\n?/gi, '').split(/\r?\n/);
  const parsed = [];
  let malformed = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const match = line.match(/^\s*\[(\d+)\]\s*(?:(you|them)\s*:\s*)?(.*)$/i);
    if (!match) {
      const trimmed = line.trim();
      // A wrapped continuation starts inside a sentence: lowercase or closing
      // punctuation. A line that starts a new sentence, a number, or a list
      // marker is model commentary we did not ask for, and joining it would
      // save that commentary as something a person said.
      const continuation = trimmed.length > 0 && !/^[\p{Lu}\d]/u.test(trimmed);
      if (/^\s*\[/.test(line) || !continuation || !parsed.length) { malformed = true; continue; }
      parsed[parsed.length - 1].text = `${parsed[parsed.length - 1].text} ${trimmed}`.trim();
      continue;
    }
    parsed.push({ index: Number(match[1]), text: String(match[3] || '').trim() });
  }

  const seen = parsed.map((line) => line.index);
  const markersMatch =
    !malformed &&
    seen.length === expected.length &&
    new Set(seen).size === seen.length &&
    seen.every((index, position) => index === expected[position]);
  if (!markersMatch) {
    return {
      failed: true,
      reason: 'marker_mismatch',
      accepted,
      rejected,
      missing: expected,
    };
  }

  for (const line of parsed) {
    const entry = byIndex.get(line.index);
    const text = line.text;
    if (!text) {
      rejected.push({ index: line.index, reason: 'empty line' });
      continue;
    }
    const rawLength = entry.text.trim().length;
    if (rawLength < MIN_SHORT_TURN_CHARS) {
      rejected.push({ index: line.index, reason: 'short turn is never rewritten' });
      continue;
    }
    const collapsedLength = collapseRepeatedTokens(entry.text).length;
    const fillerCollapsed = collapsedLength < rawLength * 0.9;
    const lowerBound = fillerCollapsed
      ? Math.max(4, MIN_LOWER_RATIO * collapsedLength)
      : Math.max(MIN_CLEANED_CHARACTERS, MIN_LOWER_RATIO * rawLength);
    const upperBound = MAX_UPPER_RATIO * rawLength;
    if (text.length < lowerBound || text.length > upperBound) {
      rejected.push({
        index: line.index,
        reason: `length guard: ${text.length} chars for a ${rawLength}-char turn`,
      });
      continue;
    }
    const issue = fidelityIssue(entry.text, text);
    if (issue) {
      rejected.push({ index: line.index, reason: issue });
      continue;
    }
    accepted.set(line.index, text);
  }

  // Every turn that has no accepted line keeps its raw wording; the count is
  // what the UI reports ("N turns kept as heard").
  const missing = expected.filter((index) => !accepted.has(index));
  return { failed: false, accepted, rejected, missing };
}

/**
 * Build the parallel cleaned array of TEXT ONLY. Speaker and timestamp are
 * always taken from the saved turn, so a model can never reassign who said
 * what, and a turn with no accepted line keeps its raw wording.
 */
function cleanedTextsFrom(turns, accepted) {
  const map = accepted instanceof Map ? accepted : new Map(Object.entries(accepted || {}).map(([key, value]) => [Number(key), value]));
  return (Array.isArray(turns) ? turns : []).map((turn, index) => {
    const cleaned = map.get(index);
    if (typeof cleaned === 'string' && cleaned.trim()) return cleaned.trim();
    return String((turn && turn.text) || '');
  });
}

module.exports = {
  CLEAN_BATCH_TURNS,
  CLEAN_BATCH_CHARACTERS,
  MAX_CLEAN_BATCHES,
  MIN_SHORT_TURN_CHARS,
  MIN_LOWER_RATIO,
  MAX_UPPER_RATIO,
  CLEAN_SYSTEM_PROMPT,
  planCleanBatches,
  buildCleanPrompt,
  parseCleanBatch,
  fidelityIssue,
  collapseRepeatedTokens,
  cleanedTextsFrom,
};
