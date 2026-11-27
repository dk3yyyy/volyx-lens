'use strict';

const { normalizeSpokenDigits } = require('./transcript-tools');

const MAX_TERMS = 100;
const MAX_TERM_CHARS = 80;
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

function parseVocabulary(value, { limit = MAX_TERMS, maxTermCharacters = MAX_TERM_CHARS } = {}) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  const seen = new Set();
  const terms = [];
  for (const entry of entries) {
    for (const raw of String(entry || '').split(/[\n,]+/)) {
      const term = cleanTerm(raw);
      if (term.length < 3 || term.length > maxTermCharacters) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
      if (terms.length >= limit) return terms;
    }
  }
  return terms;
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
  parseVocabulary,
  parseTranscriptRules,
  postProcessTranscript,
};
