'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_RECOVERY_TURNS = 500;
const MAX_TURN_CHARACTERS = 12000;

function sanitizeTurns(turns) {
  if (!Array.isArray(turns)) return { turns: [], clippedTurns: 0 };
  let clippedTurns = 0;
  const normalized = turns.slice(-MAX_RECOVERY_TURNS).flatMap((turn) => {
    if (!turn || typeof turn !== 'object') return [];
    const raw = String(turn.text || '').trim();
    if (!raw) return [];
    // Keep the end of a long turn. A single speaker can talk past the per-turn
    // limit, and the most recent words are what a recovery draft is for.
    const text = raw.length > MAX_TURN_CHARACTERS ? raw.slice(-MAX_TURN_CHARACTERS) : raw;
    if (text.length !== raw.length) clippedTurns += 1;
    return [{
      id: Number.isFinite(turn.id) ? turn.id : undefined,
      channel: turn.channel === 'you' ? 'you' : 'them',
      text,
      ts: Number.isFinite(turn.ts) ? turn.ts : undefined,
    }];
  });
  return { turns: normalized, clippedTurns };
}

function normalizeTurns(turns) {
  return sanitizeTurns(turns).turns;
}

function countValidTurns(turns) {
  if (!Array.isArray(turns)) return 0;
  return turns.reduce((total, turn) => {
    if (!turn || typeof turn !== 'object') return total;
    return String(turn.text || '').trim() ? total + 1 : total;
  }, 0);
}

function normalizeRecord(record) {
  if (!record || record.version !== 1 || !Array.isArray(record.turns)) return null;
  const turns = normalizeTurns(record.turns);
  if (!turns.length) return null;
  const totalTurns = Math.max(
    Number.isFinite(record.totalTurns) ? record.totalTurns : turns.length,
    turns.length,
  );
  const clippedTurns = Number.isFinite(record.clippedTurns) ? Math.max(0, record.clippedTurns) : 0;
  return {
    version: 1,
    startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : null,
    totalTurns,
    truncated: totalTurns - turns.length,
    clippedTurns,
    turns,
  };
}

/**
 * Count turns whose text would be lost because none of their segments were
 * finalized yet. Turns already covered by the finalize watermark are in
 * history, so trimming them is not a recovery loss.
 */
function countUnsavedTurns(turns, watermark) {
  if (!Array.isArray(turns)) return 0;
  const boundary = Number.isFinite(watermark) ? watermark : 0;
  return turns.reduce((total, turn) => {
    const segments = Array.isArray(turn && turn.segments) ? turn.segments : [];
    return segments.some((segment) => Number.isFinite(segment.id) && segment.id > boundary) ? total + 1 : total;
  }, 0);
}

function createMeetingRecovery({ file, fsImpl = fs, now = () => Date.now() } = {}) {
  if (!file || typeof file !== 'string') throw new Error('Meeting recovery requires a file path.');
  let suppressed = false;

  function clear() {
    let cleared = false;
    let firstError = null;
    for (const target of [file, `${file}.tmp`]) {
      try {
        fsImpl.unlinkSync(target);
        cleared = true;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') firstError = firstError || error;
      }
    }
    if (firstError) throw firstError;
    return { cleared };
  }

  function clearBestEffort() {
    try {
      return clear();
    } catch (error) {
      return { cleared: false, error: String(error && error.message || 'unknown').slice(0, 160) };
    }
  }

  function removeTemporaryFile() {
    try {
      fsImpl.unlinkSync(`${file}.tmp`);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  function save({ enabled = false, turns = [], startedAt = null, droppedTurns = 0, clippedTurns = 0 } = {}) {
    if (!enabled) {
      clear();
      return { saved: false, reason: 'disabled' };
    }
    if (suppressed) {
      clear();
      return { saved: false, reason: 'suppressed' };
    }
    const sanitized = sanitizeTurns(turns);
    const normalized = sanitized.turns;
    if (!normalized.length) {
      clear();
      return { saved: false, reason: 'empty' };
    }
    const carriedClipped = Math.max(0, Math.floor(Number(clippedTurns) || 0));
    const totalClipped = sanitized.clippedTurns + carriedClipped;
    const totalTurns = countValidTurns(turns) + Math.max(0, Math.floor(Number(droppedTurns) || 0));
    const record = {
      version: 1,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      updatedAt: now(),
      totalTurns,
      clippedTurns: totalClipped,
      turns: normalized,
    };
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
    return { saved: true, turnCount: normalized.length, totalTurns, truncated: totalTurns - normalized.length, clippedTurns: totalClipped };
  }

  function load({ enabled = false } = {}) {
    if (!enabled) {
      clear();
      return null;
    }

    let record;
    let temporaryRecord;
    try {
      record = normalizeRecord(JSON.parse(fsImpl.readFileSync(file, 'utf8')));
    } catch (error) {
      if (!error || (error.code !== 'ENOENT' && !(error instanceof SyntaxError))) throw error;
    }
    try {
      temporaryRecord = normalizeRecord(JSON.parse(fsImpl.readFileSync(`${file}.tmp`, 'utf8')));
    } catch (error) {
      if (!error || (error.code !== 'ENOENT' && !(error instanceof SyntaxError))) throw error;
    }

    if (temporaryRecord) {
      fsImpl.renameSync(`${file}.tmp`, file);
      return temporaryRecord;
    }
    removeTemporaryFile();
    if (record) return record;
    clear();
    return null;
  }

  function suppress() {
    suppressed = true;
    clear();
  }

  function resume() {
    suppressed = false;
  }

  function isSuppressed() {
    return suppressed;
  }

  return { save, load, clear, clearBestEffort, suppress, resume, isSuppressed };
}

module.exports = { createMeetingRecovery, normalizeTurns, countUnsavedTurns, MAX_RECOVERY_TURNS, MAX_TURN_CHARACTERS };
