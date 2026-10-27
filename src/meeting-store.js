'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_RECORDS = 200;
const MAX_RECORD_TURNS = 5000;
// Deleting a saved meeting moves it here, so a mistake costs nothing for a
// month. Clear all is the exception: it is the privacy action and removes the
// undo copies too.
const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Trash entries are named <deletedAt>-<originalMtime>-<id>.json. Both stamps
// travel with the file so a restore lands in its old place in the list without
// a sidecar to keep in sync.
const TRASH_FILE_PATTERN = /^(\d{1,16})-(\d{1,16})-([a-zA-Z0-9._-]{1,100})\.json$/;
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

  const trashDir = `${dir}-trash`;

  function ensureTrashDir() {
    fsImpl.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
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

  /**
   * Keep the newest MAX_RECORDS and remove the rest.
   *
   * Returns the number removed so the caller can say so: a record disappearing
   * with no message reads as a bug, and the saved meeting was the only copy.
   */
  function prune() {
    sweepTemporaryFiles();
    let entries;
    try {
      entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return { removed: 0 };
    }
    if (entries.length <= MAX_RECORDS) return { removed: 0 };
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
    let removed = 0;
    for (const name of entries) {
      if (keep.has(name)) continue;
      try {
        fsImpl.unlinkSync(path.join(dir, name));
        removed += 1;
      } catch {
        // Best-effort pruning; the record is still readable elsewhere.
      }
    }
    return { removed };
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
      // What the other channel is called in the UI and in exports. "Them" is a
      // placeholder, not a person.
      participant: null,
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
    const { removed } = prune();
    return { saved: true, id, turnCount: normalized.length, pruned: removed };
  }

  // Name the other speaker. Display and export only; the turns themselves keep
  // their channel, so changing the name never rewrites who spoke.
  function updateParticipant(id, name) {
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
    const value = String(name == null ? '' : name).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    record.participant = value || null;
    try {
      writeRecord(target, record, originalStat);
    } catch {
      return { updated: false, reason: 'write_failed' };
    }
    return { updated: true, participant: record.participant };
  }

  // Drop the readable copy and keep everything else. The raw transcript is the
  // record of what was said, so removing a cleaned copy must never touch it.
  function clearCleaned(id) {
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
    record.cleaned = null;
    try {
      writeRecord(target, record, originalStat);
    } catch {
      return { updated: false, reason: 'write_failed' };
    }
    return { updated: true };
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
          participant: record.participant || null,
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
          // The pane searches what it shows, so the list has to carry the
          // readable wording and the notes, not just the raw preview.
          previewCleaned: Array.isArray(record.cleaned && record.cleaned.texts)
            ? String(record.cleaned.texts.find((text) => String(text || '').trim()) || '').trim().slice(0, 120)
            : '',
          notesSummary: record.notes && record.notes.summary ? String(record.notes.summary).slice(0, 120) : '',
          notesSource: record.notes && record.notes.source ? String(record.notes.source) : null,
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
    // The record moves to the trash rather than being unlinked, so a confirm
    // clicked by mistake is recoverable for TRASH_RETENTION_DAYS. Both stamps
    // ride in the filename: when it was deleted, and the mtime it had, so a
    // restore keeps its place in the list instead of jumping to the top.
    let originalMtime = now();
    try { originalMtime = fsImpl.statSync(target).mtimeMs; } catch {}
    try {
      ensureTrashDir();
      const name = `${Math.round(now())}-${Math.round(originalMtime)}-${id}.json`;
      fsImpl.renameSync(target, path.join(trashDir, name));
      lastSavedFingerprint = null;
      return { removed: true, trashed: true };
    } catch {
      return { removed: false };
    }
  }

  function parseTrashName(name) {
    const match = String(name || '').match(TRASH_FILE_PATTERN);
    if (!match) return null;
    const id = match[3];
    if (!isSafeId(id)) return null;
    return { id, deletedAt: Number(match[1]), mtimeMs: Number(match[2]) };
  }

  // Newest entry per id, so a record deleted twice restores the latest copy.
  function trashIndex() {
    const index = new Map();
    let names = [];
    try {
      names = fsImpl.readdirSync(trashDir);
    } catch {
      return index;
    }
    for (const name of names) {
      const parsed = parseTrashName(name);
      if (!parsed) continue;
      const seen = index.get(parsed.id);
      if (!seen || parsed.deletedAt > seen.deletedAt) index.set(parsed.id, { ...parsed, name });
    }
    return index;
  }

  /**
   * Put deleted meetings back.
   *
   * A full history refuses instead of restoring and immediately pruning: the
   * record would vanish again in the same breath, and "restored" would be a lie.
   * The copy stays in the trash so the user can make room and try again.
   */
  function restoreDeleted(ids) {
    const requested = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (isSafeId(id) && !requested.includes(id)) requested.push(id);
    }
    const index = trashIndex();
    const available = Math.max(0, MAX_RECORDS - list().length);
    const missing = [];
    let restored = 0;
    let blocked = 0;
    for (const id of requested) {
      const entry = index.get(id);
      if (!entry) {
        missing.push(id);
        continue;
      }
      if (restored >= available) {
        blocked += 1;
        continue;
      }
      const target = recordPath(id);
      let taken = false;
      try { fsImpl.statSync(target); taken = true; } catch {}
      if (taken) {
        missing.push(id);
        continue;
      }
      try {
        fsImpl.renameSync(path.join(trashDir, entry.name), target);
      } catch {
        missing.push(id);
        continue;
      }
      try { fsImpl.utimesSync(target, entry.mtimeMs / 1000, entry.mtimeMs / 1000); } catch {}
      lastSavedFingerprint = null;
      restored += 1;
    }
    return { restored, missing, blocked };
  }

  // Ids currently in the undo folder, newest first. The pane uses this to offer
  // a restore on the next launch, so the window is not limited to the session
  // that did the deleting.
  function trashIds() {
    return [...trashIndex().values()]
      .sort((a, b) => b.deletedAt - a.deletedAt)
      .map((entry) => entry.id);
  }

  // Undo is a convenience with a lifetime. Anything older than the window is
  // gone for good, which is what makes the week-long window a real promise.
  function purgeTrash({ keepMs = TRASH_RETENTION_DAYS * DAY_MS, at = null } = {}) {
    const reference = Number.isFinite(at) ? at : now();
    const keepWindow = Number.isFinite(keepMs) && keepMs > 0 ? keepMs : 0;
    let names = [];
    try {
      names = fsImpl.readdirSync(trashDir);
    } catch {
      return { removed: 0 };
    }
    let removed = 0;
    for (const name of names) {
      const parsed = parseTrashName(name);
      if (!parsed) continue;
      if (reference - parsed.deletedAt < keepWindow) continue;
      try {
        fsImpl.unlinkSync(path.join(trashDir, name));
        removed += 1;
      } catch {
        // Best effort; the next pass tries again.
      }
    }
    return { removed };
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
    // Clear all is the privacy action: it removes the undo copies too, so the
    // records do not survive in a folder the user was told was empty.
    const trashCleared = purgeTrash({ keepMs: 0 }).removed;
    return { cleared, trashCleared };
  }

  // Delete records that ended before the retention window. Zero, a negative
  // number, or anything that is not a number keeps everything: losing a
  // transcript to a bad setting is worse than keeping it longer.
  function pruneOlderThan(days, options = {}) {
    const window = Number(days);
    if (!Number.isFinite(window) || window <= 0) return { removed: 0 };
    const reference = Number.isFinite(options.now) ? options.now : now();
    const cutoff = reference - window * 24 * 60 * 60 * 1000;
    let entries;
    try {
      entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return { removed: 0 };
    }
    let removed = 0;
    for (const name of entries) {
      const id = name.slice(0, -'.json'.length);
      if (!isSafeId(id)) continue;
      try {
        const record = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf8'));
        const endedAt = Number.isFinite(record && record.endedAt) ? record.endedAt : null;
        if (endedAt === null || endedAt >= cutoff) continue;
        fsImpl.unlinkSync(path.join(dir, name));
        removed += 1;
      } catch {
        // A record that cannot be read is left for the next pass.
      }
    }
    return { removed };
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
    const stats = cleaned && cleaned.stats && typeof cleaned.stats === 'object' ? {
      cleanedTurns: Number.isFinite(cleaned.stats.cleanedTurns) ? cleaned.stats.cleanedTurns : null,
      rawFallbacks: Number.isFinite(cleaned.stats.rawFallbacks) ? cleaned.stats.rawFallbacks : null,
      failedBatches: Number.isFinite(cleaned.stats.failedBatches) ? cleaned.stats.failedBatches : null,
      batches: Number.isFinite(cleaned.stats.batches) ? cleaned.stats.batches : null,
    } : null;
    record.cleaned = {
      version: 1,
      at: Number.isFinite(cleaned && cleaned.at) ? cleaned.at : now(),
      model: cleaned && cleaned.model ? String(cleaned.model).slice(0, 120) : null,
      provider: cleaned && cleaned.provider ? String(cleaned.provider).slice(0, 120) : null,
      sourceHash,
      // How much of the transcript the pass actually repaired, so the pane can
      // say "42 of 45 turns" long after the run finished.
      stats,
      texts,
    };
    try {
      writeRecord(target, record, originalStat);
    } catch {
      return { updated: false, reason: 'write_failed' };
    }
    return { updated: true, turnCount: texts.length };
  }

  // Every saved record, in full. A backup has to be restorable, so this reads
  // the same bytes list() and get() would give rather than a summary.
  function readAll() {
    const records = [];
    const unreadable = [];
    for (const entry of list()) {
      const record = get(entry.id);
      if (record) records.push(record);
      else unreadable.push(entry.id);
    }
    return { records, unreadable };
  }

  /**
   * Restore records read from a backup folder.
   *
   * Every record goes through the normalisation a captured meeting gets, so a
   * restored file cannot introduce a shape the rest of the app does not expect.
   * An empty transcript is skipped and named instead of imported as a shell, and
   * a colliding id gets a fresh one, so a restore can never overwrite a meeting
   * saved after the backup was taken.
   */
  function importRecords(records) {
    const incoming = Array.isArray(records) ? records : [];
    const skipped = [];
    const prepared = [];
    for (const candidate of incoming) {
      if (!candidate || typeof candidate !== 'object') {
        skipped.push({ id: null, reason: 'not_a_record' });
        continue;
      }
      const label = typeof candidate.id === 'string' && isSafeId(candidate.id) ? candidate.id : null;
      const normalized = snapshotTurns(candidate.turns);
      if (!normalized.length) {
        skipped.push({ id: label, reason: 'empty_transcript' });
        continue;
      }
      prepared.push({ label, normalized, candidate });
    }

    // Refuse before writing anything when the restore cannot fit. Writing first
    // and pruning afterwards is how a restore of older meetings used to delete
    // every record it had just restored, then report success.
    const capacity = Math.max(0, MAX_RECORDS - list().length);
    if (prepared.length > capacity) {
      return {
        imported: 0,
        ids: [],
        skipped,
        blocked: prepared.length,
        capacity,
        pruned: 0,
        reason: 'no_room',
      };
    }

    const written = [];
    for (const { label, normalized, candidate } of prepared) {
      ensureDir();
      let id = label;
      if (id) {
        let taken = false;
        try { fsImpl.statSync(recordPath(id)); taken = true; } catch {}
        if (taken) id = null;
      }
      if (!id) id = crypto.randomUUID();
      const endedAt = Number.isFinite(candidate.endedAt) ? candidate.endedAt : now();
      const record = {
        id,
        version: 1,
        reason: typeof candidate.reason === 'string' && candidate.reason.trim()
          ? candidate.reason.trim().slice(0, 60)
          : 'restored',
        meeting: candidate.meeting === true,
        startedAt: Number.isFinite(candidate.startedAt) ? candidate.startedAt : null,
        endedAt,
        turnCount: normalized.length,
        turns: normalized,
        participant: null,
        notes: null,
        cleaned: null,
      };
      const target = recordPath(id);
      try {
        writeRecord(target, record);
      } catch {
        skipped.push({ id: label, reason: 'write_failed' });
        continue;
      }
      // Ordering lives in mtime, so a restored meeting keeps its place in the
      // list instead of jumping to the top as if it were just recorded.
      try { fsImpl.utimesSync(target, endedAt / 1000, endedAt / 1000); } catch {}
      if (typeof candidate.participant === 'string') updateParticipant(id, candidate.participant);
      if (candidate.notes && typeof candidate.notes === 'object') updateNotes(id, candidate.notes);
      if (candidate.cleaned && Array.isArray(candidate.cleaned.texts) && candidate.cleaned.texts.length === normalized.length) {
        const cleaned = candidate.cleaned;
        // sourceHash is recomputed from the stored turns; passing the backup's
        // own hash would refuse the copy whenever normalisation changed a turn.
        updateCleaned(id, {
          version: 1,
          at: cleaned.at,
          model: cleaned.model,
          provider: cleaned.provider,
          stats: cleaned.stats,
          texts: cleaned.texts,
        });
      }
      written.push(id);
    }

    const { removed } = prune();
    // Report what is in the store, not what was attempted: if anything above
    // behaved unexpectedly the count must fall, never overstate.
    const listed = new Set(list().map((record) => record.id));
    const ids = written.filter((id) => listed.has(id));
    return { imported: ids.length, ids, skipped, blocked: 0, capacity, pruned: removed };
  }

  return {
    finalize,
    list,
    get,
    readAll,
    importRecords,
    remove,
    restoreDeleted,
    trashIds,
    purgeTrash,
    clear,
    updateNotes,
    updateCleaned,
    updateParticipant,
    clearCleaned,
    pruneOlderThan,
    recordPath,
    fingerprint,
    maxRecords: MAX_RECORDS,
    trashRetentionDays: TRASH_RETENTION_DAYS,
  };
}

module.exports = { createMeetingStore, snapshotTurns, fingerprint, MAX_RECORDS, MAX_RECORD_TURNS, isSafeId };
