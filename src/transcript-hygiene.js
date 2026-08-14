'use strict';

// Transcript hygiene for the batch/offline transcription path.
//
// Two problems this module solves, both observed with local whisper.cpp:
//
// 1. Silence artifacts. Whisper happily transcribes quiet or noise-only audio
//    as a polite closing line ("Thank you for watching.", "Bye-bye!") and
//    sometimes as a lone filler token. Those rows are worse than no transcript
//    at all — they read as real speech in a meeting. We drop them.
//
// 2. Domain terms. Whisper mis-spells names it has never seen (model ids,
//    product names, project acronyms). Seeding the recognizer with an initial
//    prompt of the terms the user is likely to say measurably improves WER on
//    technical dictation. We build that seed from the user's personal context
//    documents (resume, job description, enabled references), which is the
//    same privacy-safe corpus the rest of the app already uses.
//
// Scope note: this applies to the batch/fallback chain only. Realtime sessions
// (gpt-realtime-whisper and friends) run their own turn detection and are left
// untouched.

// Common English words, number words, and filler that would otherwise match the
// "proper noun" pattern below (uppercase or contains a digit). Keeping them out
// of the seed prompt avoids noise like "The" or "Forty".
const STOP_WORDS = new Set(
  ('a an and are as at be been but by can could did do does for from had has have how i if in into is it its ' +
   'may my of on or our should so than that the their them then there these they this to was we were what when ' +
   'where which who why will with would you your the this those these over under about after before between every ' +
   'first last next same such too very just also still even well back down up off one two three four five six seven ' +
   'eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty ' +
   'fifty sixty seventy eighty ninety hundred thousand million billion percent dollars dollar pm am version okay ' +
   'new more most only into').split(' ')
);

// Whisper silence artifacts — full closing lines the recognizer produces on
// noise-only audio. This is an exact whole-utterance match, and the list is
// deliberately conservative. Short, generic phrases are excluded even though
// whisper sometimes utters them on silence: "thank you", "bye-bye", or "see
// you next time" are perfectly normal meeting turns, and a false positive here
// silently deletes real speech (the failure mode this filter exists to avoid).
// Only distinctive content-creator closers — the phrasing whisper actually
// hallucinates on noise, and that no one says as a work utterance — plus
// emoji-only output are treated as hallucinations.
const HALLUCINATION_ARTIFACTS = new Set([
  'thank you for watching',
  'thanks for watching',
  'thank you for listening',
  'thanks for listening',
  'please subscribe',
  'please like and subscribe',
  'like and subscribe',
  'subscribe to my channel',
]);

// Default seed vocabulary. Deliberately small and general — the real value
// comes from the user-specific terms appended in buildSttVocab.
const BASE_STT_VOCAB =
  'meeting, transcription, realtime, latency, endpoint, deployment, model, provider, API key, ' +
  'microphone, system audio, screen share, loopback, capture, utterance, transcript, partial, final, ' +
  'reliability, uptime, pipeline, fallback, streaming, resolution, noise, echo, budget, review, quarterly';

// Matches tokens that look like names, acronyms, or model ids: at least three
// characters, containing an uppercase letter or a digit, and not a stop word.
function extractDomainTerms(text) {
  const tokens = String(text || '').match(/\b[A-Za-z0-9][A-Za-z0-9+.#/-]*\b/g) || [];
  const seen = new Set();
  const kept = [];
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (!/[A-Z0-9]/.test(token)) continue;
    const key = token.toLowerCase();
    if (STOP_WORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push(token);
  }
  return kept.slice(0, 60);
}

/**
 * Build the initial-prompt seed for STT from personal context text.
 * Returns a comma-joined string of the base vocabulary plus any domain terms
 * extracted from the context, capped at maxChars characters.
 */
function buildSttVocab({ personalContext = '', base = BASE_STT_VOCAB, maxChars = 900 } = {}) {
  const terms = extractDomainTerms(personalContext);
  let vocab = base;
  if (terms.length) vocab = `${base}, ${terms.join(', ')}`;
  if (vocab.length > maxChars) {
    // Cut at a word boundary rather than mid-token.
    vocab = vocab.slice(0, maxChars).replace(/,\s*[^,]*$/, '');
  }
  return vocab;
}

/**
 * True when the text is empty, emoji-only, or one of the known whisper silence
 * artifacts. Used to drop phantom rows before they reach the transcript.
 */
function looksLikeHallucination(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return true;
  const normalized = trimmed.replace(/[.,!?…]+$/g, '').trim().toLowerCase();
  return HALLUCINATION_ARTIFACTS.has(normalized);
}

/** Apply hygiene to a transcript: '' when it is a silence artifact, else the trimmed text. */
function filterTranscript(text) {
  if (looksLikeHallucination(text)) return '';
  return String(text || '').trim();
}

module.exports = { BASE_STT_VOCAB, buildSttVocab, looksLikeHallucination, filterTranscript, extractDomainTerms };
