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
  // Filesystems with coarse or same-millisecond timestamps (NTFS during rapid
  // writes) can make prune() unable to order records by mtime alone. Stamping
  // each record with a strictly increasing mtime keeps prune deterministic.
  let lastWriteMs = 0;

  function ensureDir() {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  function recordPath(id) {
    if (!isSafeId(id)) throw new Error(`Invalid meeting id: ${String(id).slice(0, 40)}`);
    return path.join(dir, `${id}.json`);
  }

  // Every mutation goes through a temp file plus rename, so a crash or a full
  // disk leaves the previous record intact instead of a truncated one. The
  // original mtime is restored because list() and prune() order by it.
  // Each write gets its own temp name. Two app instances can share this folder
  // (there is no single-instance lock), and a sweep must never mistake another
  // instance's in-flight file for a crashed one.
  function temporaryPath(target) {
    return `${target}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  }

  function writeRecord(target, record, originalStat) {
    const tmp = temporaryPath(target);
    try {
      fsImpl.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      fsImpl.renameSync(tmp, target);
    } catch (error) {
      // A half-written temp file is a full copy of the meeting left on disk,
      // so it is removed before the failure is reported.
      try { fsImpl.unlinkSync(tmp); } catch {}
      throw error;
    }
    if (originalStat && Number.isFinite(originalStat.atimeMs)) {
      try { fsImpl.utimesSync(target, originalStat.atimeMs / 1000, originalStat.mtimeMs / 1000); } catch {}
    }
  }

  // Temp files are only meaningful while a write is in flight. A file this old
  // belongs to a writer that died, so it is swept; anything newer may belong to
  // another running instance and is left alone.
  const STALE_TEMP_MS = 60 * 1000;

  function sweepTemporaryFiles() {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!/\.json(\..*)?\.tmp$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fsImpl.statSync(file);
        if (now() - stat.mtimeMs < STALE_TEMP_MS) continue;
        fsImpl.unlinkSync(file);
      } catch {}
    }
  }

  function prune() {
    sweepTemporaryFiles();
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
      notes: null,
      // A cleaned, readable copy of the same turns, written only when the user
      // asks for it. `turns` above always keeps the recognizer's wording.
      cleaned: null,
    };
    const target = recordPath(id);
    const tmp = `${target}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fsImpl.renameSync(tmp, target);
    const writeStamp = Math.max(now(), lastWriteMs + 1);
    lastWriteMs = writeStamp;
    try { fsImpl.utimesSync(target, writeStamp / 1000, writeStamp / 1000); } catch {}
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
          hasNotes: !!record.notes && (record.notes.summary || record.notes.keyPoints?.length || record.notes.actionItems?.length),
          hasCleaned: Array.isArray(record.cleaned && record.cleaned.texts)
            && record.cleaned.texts.length === (Array.isArray(record.turns) ? record.turns.length : 0)
            && record.cleaned.texts.length > 0,
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
    const turns = snapshotTurns(record.turns);
    // A cleaned copy is only surfaced when it still describes these exact turns.
    const stored = record.cleaned;
    let cleaned = null;
    if (stored && Array.isArray(stored.texts) && stored.texts.length === turns.length && turns.length) {
      const currentHash = fingerprint(turns) ? fingerprint(turns).contentHash : null;
      if (currentHash && (!stored.sourceHash || stored.sourceHash === currentHash)) {
        cleaned = { ...stored, texts: stored.texts.map((text) => String(text || '').slice(0, 12000)) };
      }
    }
    return { ...record, turns, cleaned };
  }

  function remove(id) {
    if (!isSafeId(id)) throw new Error(`Invalid meeting id: ${String(id).slice(0, 40)}`);
    const target = recordPath(id);
    try {
      for (const name of fsImpl.readdirSync(dir)) {
        if (name.startsWith(`${path.basename(target)}.`) && name.endsWith('.tmp')) {
          try { fsImpl.unlinkSync(path.join(dir, name)); } catch {}
        }
      }
    } catch {}
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
      if (/\.json(\..*)?\.tmp$/.test(name)) { try { fsImpl.unlinkSync(path.join(dir, name)); } catch {} continue; }
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

  function updateNotes(id, notes) {
    if (!isSafeId(id)) return { updated: false, reason: 'invalid_id' };
    const target = recordPath(id);
    let originalStat = null;
    let record;
    try {
      originalStat = fsImpl.statSync(target);
      record = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
    } catch {
      return { updated: false, reason: 'not_found' };
    }
    if (!record || typeof record !== 'object') return { updated: false, reason: 'not_found' };
    record.notes = notes;
    try {
      writeRecord(target, record, originalStat);
    } catch {
      return { updated: false, reason: 'write_failed' };
    }
    return { updated: true };
  }

  // Store a readable copy of the same turns. The record's own `turns` array is
  // never rewritten: the cleaned copy must stay parallel (same length, matching
  // source hash) or it is refused, because a mismatch would mean content was
  // dropped or invented somewhere upstream. Only text is stored; speaker and
  // timestamp always come from the saved turn, so a model cannot reassign who
  // said what.
  function updateCleaned(id, cleaned) {
    if (!isSafeId(id)) return { updated: false, reason: 'invalid_id' };
    const target = recordPath(id);
    let record;
    let originalStat = null;
    try {
      originalStat = fsImpl.statSync(target);
      record = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
    } catch {
      return { updated: false, reason: 'not_found' };
    }
    if (!record || typeof record !== 'object') return { updated: false, reason: 'not_found' };
    const source = Array.isArray(record.turns) ? record.turns : [];
    const incoming = Array.isArray(cleaned && cleaned.texts) ? cleaned.texts : null;
    if (!incoming) return { updated: false, reason: 'invalid_payload' };
    if (incoming.length !== source.length) return { updated: false, reason: 'turn_count_mismatch' };
    const sourceHash = fingerprint(source) ? fingerprint(source).contentHash : null;
    if (!sourceHash) return { updated: false, reason: 'empty_source' };
    if (cleaned.sourceHash && cleaned.sourceHash !== sourceHash) {
      return { updated: false, reason: 'source_changed' };
    }
    const texts = [];
    for (let index = 0; index < incoming.length; index += 1) {
      const text = String(incoming[index] == null ? '' : incoming[index]).trim();
      if (!text) return { updated: false, reason: 'empty_text' };
      texts.push(text.slice(0, 12000));
    }
    record.cleaned = {
      version: 1,
      at: Number.isFinite(cleaned && cleaned.at) ? cleaned.at : now(),
      model: cleaned && cleaned.model ? String(cleaned.model).slice(0, 120) : null,
      provider: cleaned && cleaned.provider ? String(cleaned.provider).slice(0, 120) : null,
      sourceHash,
      texts,
    };
    try {
      writeRecord(target, record, originalStat);
    } catch {
      return { updated: false, reason: 'write_failed' };
    }
    return { updated: true, turnCount: texts.length };
  }

  return { finalize, list, get, remove, clear, updateNotes, updateCleaned, recordPath, fingerprint };
}

module.exports = { createMeetingStore, snapshotTurns, fingerprint, MAX_RECORDS, MAX_RECORD_TURNS, isSafeId };
