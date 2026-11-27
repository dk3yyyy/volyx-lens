'use strict';

const { insertConversationSegment } = require('./transcript-grouping');

const MAX_SUPPRESSED_YOU_SEGMENTS = 200;
const MAX_SUPPRESSED_YOU_CHARACTERS = 12000;
const SUPPRESSED_ID_PATTERN = /^suppressed-\d+$/;

function normalizeSuppressedYouSegments(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(-MAX_SUPPRESSED_YOU_SEGMENTS).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const text = String(entry.text || '').trim().slice(0, MAX_SUPPRESSED_YOU_CHARACTERS);
    if (!text) return [];
    const normalized = {
      text,
      ts: Number.isFinite(entry.ts) ? entry.ts : null,
      duplicateOf: Number.isFinite(entry.duplicateOf) ? entry.duplicateOf : null,
      match: String(entry.match || '').slice(0, 40),
      reason: String(entry.reason || '').slice(0, 40),
    };
    if (typeof entry.id === 'string' && SUPPRESSED_ID_PATTERN.test(entry.id)) normalized.id = entry.id;
    return [normalized];
  });
}

function findSuppressedYouIndex(entries, idOrIndex) {
  if (!Array.isArray(entries)) return -1;
  if (Number.isSafeInteger(idOrIndex)) {
    return idOrIndex >= 0 && idOrIndex < entries.length ? idOrIndex : -1;
  }
  if (typeof idOrIndex !== 'string' || !idOrIndex) return -1;
  return entries.findIndex((entry) => entry && entry.id === idOrIndex);
}

function restoreSuppressedYouSegment(turns, entry, { segmentId, createTurnId } = {}) {
  const text = String(entry && entry.text || '').trim();
  if (!text) throw new TypeError('A suppressed transcript line requires text.');
  if (!Number.isSafeInteger(segmentId) || segmentId < 1) throw new TypeError('A restored transcript segment requires an id.');
  if (typeof createTurnId !== 'function') throw new TypeError('A restored transcript segment requires a turn id factory.');
  return insertConversationSegment(turns, {
    id: segmentId,
    channel: 'you',
    text,
    ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
  }, createTurnId);
}

module.exports = {
  MAX_SUPPRESSED_YOU_SEGMENTS,
  MAX_SUPPRESSED_YOU_CHARACTERS,
  normalizeSuppressedYouSegments,
  findSuppressedYouIndex,
  restoreSuppressedYouSegment,
};
