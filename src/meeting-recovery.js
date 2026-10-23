'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_RECOVERY_TURNS = 500;
const MAX_TURN_CHARACTERS = 12000;

function normalizeTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.slice(-MAX_RECOVERY_TURNS).flatMap((turn) => {
    if (!turn || typeof turn !== 'object') return [];
    const text = String(turn.text || '').trim().slice(0, MAX_TURN_CHARACTERS);
    if (!text) return [];
    return [{
      id: Number.isFinite(turn.id) ? turn.id : undefined,
      channel: turn.channel === 'you' ? 'you' : 'them',
      text,
      ts: Number.isFinite(turn.ts) ? turn.ts : undefined,
    }];
  });
}

function normalizeRecord(record) {
  if (!record || record.version !== 1 || !Array.isArray(record.turns)) return null;
  const turns = normalizeTurns(record.turns);
  if (!turns.length) return null;
  return {
    version: 1,
    startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : null,
    turns,
  };
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

  function removeTemporaryFile() {
    try {
      fsImpl.unlinkSync(`${file}.tmp`);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  function save({ enabled = false, turns = [], startedAt = null } = {}) {
    if (!enabled) {
      clear();
      return { saved: false, reason: 'disabled' };
    }
    if (suppressed) {
      clear();
      return { saved: false, reason: 'suppressed' };
    }
    const normalized = normalizeTurns(turns);
    if (!normalized.length) {
      clear();
      return { saved: false, reason: 'empty' };
    }
    const record = {
      version: 1,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      updatedAt: now(),
      turns: normalized,
    };
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
    return { saved: true, turnCount: normalized.length };
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

  return { save, load, clear, suppress, resume, isSuppressed };
}

module.exports = { createMeetingRecovery, normalizeTurns, MAX_RECOVERY_TURNS, MAX_TURN_CHARACTERS };
