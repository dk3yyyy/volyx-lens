'use strict';

const { normalizeSpokenDigits } = require('./transcript-tools');

const MAX_TERMS = 100;
const MAX_TERM_CHARS = 80;
// The speech providers accept short hint lists; 40 characters is the per-term
// budget the realtime seed enforces, so parsing rejects longer terms instead of
// accepting one that later disappears from the recognizer's list.
const MAX_VOCABULARY_TERM_CHARS = 40;
const MAX_RULES = 100;
const MAX_RULE_FROM_CHARS = 80;
const MAX_RULE_TO_CHARS = 160;
const MAX_TRANSCRIPT_CHARS = 12000;

function cleanTerm(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Two-character hints are real vocabulary when they carry information: acronyms
// (AI, ML), letter-digit ids (Q3, X1, 3D). Bare lowercase pairs and bare digits
// are indistinguishable from noise, so they stay rejected.
function isMeaningfulShortTerm(term) {
  const characters = [...term];
  if (characters.length !== 2 || !/^[\p{L}\p{N}]{2}$/u.test(term)) return false;
  if (/\p{Lu}/u.test(term)) return true;
  if (/\p{L}/u.test(term) && /\p{N}/u.test(term)) return true;
  // Scripts without case (Han, Hiragana, Katakana, Hangul) cannot use the
  // uppercase rule, and a two-character word there is a real term.
  return characters.some((character) => /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character));
}

function inspectVocabulary(value, { limit = MAX_TERMS, maxTermCharacters = MAX_VOCABULARY_TERM_CHARS } = {}) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  const seen = new Set();
  const terms = [];
  // Rejections used to disappear, so a user who typed "AI" believed the hint
  // was active. Collect them (bounded) and let the caller surface the count.
  const rejected = [];
  let rejectedCount = 0;
  const reject = (term, reason) => {
    rejectedCount += 1;
    if (rejected.length < 10) rejected.push({ term: term.slice(0, 40), reason });
  };
  for (const entry of entries) {
    for (const raw of String(entry || '').split(/[\n,]+/)) {
      const term = cleanTerm(raw);
      // Separators and blank lines are not user-visible entries.
      if (!term) continue;
      if (term.length > maxTermCharacters) { reject(term, 'too_long'); continue; }
      if (term.length < 3 && !isMeaningfulShortTerm(term)) { reject(term, 'too_short'); continue; }
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      if (terms.length >= limit) { reject(term, 'over_limit'); continue; }
      seen.add(key);
      terms.push(term);
    }
  }
  return { terms, rejected, rejectedCount };
}

function parseVocabulary(value, options) {
  return inspectVocabulary(value, options).terms;
}

function parseTranscriptRules(value, {
  limit = MAX_RULES,
  maxSourceLength = MAX_RULE_FROM_CHARS,
  maxReplacementLength = MAX_RULE_TO_CHARS,
} = {}) {
  const entries = Array.isArray(value)
    ? value
    : String(value || '').split(/\r?\n/);
  const seen = new Set();
  const rules = [];
  for (const entry of entries) {
    let from = '';
    let to = '';
    if (entry && typeof entry === 'object') {
      from = cleanTerm(entry.from);
      to = cleanTerm(entry.to);
    } else {
      const line = String(entry || '');
      const separator = line.indexOf('=>');
      if (separator < 0) continue;
      from = cleanTerm(line.slice(0, separator));
      to = cleanTerm(line.slice(separator + 2));
    }
    if (!from || !to || from.length > maxSourceLength || to.length > maxReplacementLength) continue;
    const key = from.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ from, to });
    if (rules.length >= limit) break;
  }
  return rules;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rulePattern(rule) {
  const escaped = escapeRegExp(rule.from);
  const left = /^[\p{L}\p{N}]/u.test(rule.from) ? '(?<![\\p{L}\\p{N}])' : '';
  const right = /[\p{L}\p{N}]$/u.test(rule.from) ? '(?![\\p{L}\\p{N}])' : '';
  return `${left}${escaped}${right}`;
}

function postProcessTranscript(value, { enabled = true, normalizeDigits = true, rules = [] } = {}) {
  const rawText = String(value || '').trim().slice(0, MAX_TRANSCRIPT_CHARS);
  if (!rawText) return { text: '', rawText: '', changed: false, replacements: [] };
  if (enabled === false) return { text: rawText, rawText, changed: false, replacements: [] };

  const parsedRules = parseTranscriptRules(rules)
    .sort((left, right) => right.from.length - left.from.length);
  const replacements = [];
  let text = rawText;
  if (parsedRules.length) {
    const byMatch = new Map(parsedRules.map((rule) => [rule.from.toLowerCase(), rule]));
    const pattern = new RegExp(parsedRules.map(rulePattern).join('|'), 'giu');
    text = text.replace(pattern, (match) => {
      const rule = byMatch.get(match.toLowerCase());
      if (!rule) return match;
      if (!replacements.includes(rule.from)) replacements.push(rule.from);
      return rule.to;
    });
  }
  if (normalizeDigits !== false) text = normalizeSpokenDigits(text);
  text = text.trim().slice(0, MAX_TRANSCRIPT_CHARS);
  return { text, rawText, changed: text !== rawText, replacements };
}

module.exports = {
  MAX_TRANSCRIPT_CHARS,
  inspectVocabulary,
  parseVocabulary,
  parseTranscriptRules,
  postProcessTranscript,
};
