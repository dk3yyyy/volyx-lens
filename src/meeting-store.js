'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_RECORDS = 200;
const MAX_RECORD_TURNS = 5000;
const ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 100 && id !== '.' && id !== '..' && ID_PATTERN.test(id) && path.basename(id) === id;
}

function snapshotTurns(turns) {
  if (!Array.isArray(turns)) return [];
  const normalized = [];
  for (const raw of turns) {
    if (!raw || typeof raw !== 'object') continue;
    const text = String(raw.text || '').slice(0, 12000);
    if (!text.trim()) continue;
    normalized.push({
      id: Number.isFinite(raw.id) ? raw.id : undefined,
      channel: raw.channel === 'you' ? 'you' : 'them',
      text,
      ts: Number.isFinite(raw.ts) ? raw.ts : undefined,
    });
  }
  return normalized.slice(-MAX_RECORD_TURNS);
}

function fingerprint(turns) {
  const normalized = snapshotTurns(turns);
  if (!normalized.length) return null;
  const last = normalized[normalized.length - 1];
  const digest = crypto.createHash('sha256');
  for (const turn of normalized) {
    digest.update(`${turn.id ?? ''}|${turn.channel}|${turn.text}|${turn.ts ?? ''}\n`);
  }
  return { count: normalized.length, lastId: last.id, lastTs: last.ts, contentHash: digest.digest('hex') };
}

function previewText(turns) {
  for (const turn of Array.isArray(turns) ? turns : []) {
    const text = String((turn && turn.text) || '').trim();
    if (text) return text.slice(0, 120);
  }
  return '';
}

function createMeetingStore({ dir, fsImpl = fs, now = () => Date.now() } = {}) {
  if (!dir || typeof dir !== 'string') throw new Error('Meeting store requires a directory.');
  let lastSavedFingerprint = null;

  function ensureDir() {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  function recordPath(id) {
    if (!isSafeId(id)) throw new Error(`Invalid meeting id: ${String(id).slice(0, 40)}`);
    return path.join(dir, `${id}.json`);
  }

  function prune() {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    if (entries.length <= MAX_RECORDS) return;
    const timed = [];
    for (const name of entries) {
      try {
        const stat = fsImpl.statSync(path.join(dir, name));
        timed.push({ name, mtimeMs: stat.mtimeMs });
      } catch {
        // Unreadable files are treated as oldest so a later pass prunes them.
      }
    }
    timed.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = new Set(timed.slice(0, MAX_RECORDS).map((entry) => entry.name));
    for (const name of entries) {
      if (keep.has(name)) continue;
      try {
        fsImpl.unlinkSync(path.join(dir, name));
      } catch {
        // Best-effort pruning; the record is still readable elsewhere.
      }
    }
  }

  function finalize({ turns = [], enabled = false, reason = 'capture-stop', meeting = false, startedAt = null, endedAt = null } = {}) {
    if (!enabled) return { saved: false, reason: 'disabled' };
    const normalized = snapshotTurns(turns);
    if (!normalized.length) return { saved: false, reason: 'empty' };
    const fp = fingerprint(normalized);
    if (lastSavedFingerprint && fp && fp.contentHash === lastSavedFingerprint.contentHash) {
      return { saved: false, reason: 'no_new_content' };
    }
    ensureDir();
    const id = crypto.randomUUID();
    const record = {
      id,
      version: 1,
      reason,
      meeting: meeting === true,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      endedAt: Number.isFinite(endedAt) ? endedAt : now(),
      turnCount: normalized.length,
      turns: normalized,
    };
    const target = recordPath(id);
    const tmp = `${target}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fsImpl.renameSync(tmp, target);
    lastSavedFingerprint = fp;
    prune();
    return { saved: true, id, turnCount: normalized.length };
  }

  function list() {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir);
    } catch {
      return [];
    }
    const records = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!isSafeId(id)) continue;
      try {
        const record = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf8'));
        if (!record || typeof record !== 'object') continue;
        records.push({
          id,
          reason: record.reason || null,
          meeting: record.meeting === true,
          startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
          endedAt: Number.isFinite(record.endedAt) ? record.endedAt : null,
          turnCount: Array.isArray(record.turns) ? record.turns.length : 0,
          preview: previewText(record.turns),
        });
      } catch {
        // Skip corrupt records rather than breaking the whole list.
      }
    }
    return records.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  }

  function get(id) {
    if (!isSafeId(id)) throw new Error(`Invalid meeting id: ${String(id).slice(0, 40)}`);
    const target = recordPath(id);
    let record;
    try {
      record = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
    } catch {
      return null;
    }
    if (!record || typeof record !== 'object') return null;
    return { ...record, turns: snapshotTurns(record.turns) };
  }

  function remove(id) {
    if (!isSafeId(id)) throw new Error(`Invalid meeting id: ${String(id).slice(0, 40)}`);
    const target = recordPath(id);
    try {
      fsImpl.unlinkSync(target);
      return { removed: true };
    } catch {
      return { removed: false };
    }
  }

  function clear() {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir);
    } catch {
      return { cleared: 0 };
    }
    let cleared = 0;
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        fsImpl.unlinkSync(path.join(dir, name));
        cleared += 1;
      } catch {
        // Best-effort clear.
      }
    }
    lastSavedFingerprint = null;
    return { cleared };
  }

  return { finalize, list, get, remove, clear, recordPath, fingerprint };
}

module.exports = { createMeetingStore, snapshotTurns, fingerprint, MAX_RECORDS, MAX_RECORD_TURNS, isSafeId };
