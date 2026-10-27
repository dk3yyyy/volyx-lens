'use strict';

// Backing up every saved meeting.
//
// A backup has one job: put the user's records somewhere else in a form that can
// come back. So each record is written exactly as the store holds it (raw turns,
// participant, notes, cleaned copy), and an index names what the folder holds.
// Restore reads those files back through the same validators the store uses, so
// a damaged or unrelated file is reported instead of imported.

const INDEX_KIND = 'volyx-lens-backup-index';
const INDEX_NAME = 'volyx-lens-backup-index.json';
const MAX_BACKUP_FILES = 5000;
const MAX_BACKUP_FILE_BYTES = 8 * 1024 * 1024;

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

function fileStamp(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  if (Number.isNaN(date.getTime())) return '0000-00-00';
  return [
    date.getFullYear(),
    twoDigits(date.getMonth() + 1),
    twoDigits(date.getDate()),
  ].join('-') + '-' + twoDigits(date.getHours()) + twoDigits(date.getMinutes());
}

function shortId(id) {
  const text = String(id || '').replace(/[^0-9a-zA-Z]/g, '');
  return text ? text.slice(0, 8) : 'record';
}

/**
 * One file per saved meeting plus an index.
 *
 * Names are readable and stable enough to sort in a file manager: the meeting's
 * end time first, then a short id so two meetings in the same minute stay
 * distinct. Content is the record itself, unmodified, which is what makes the
 * folder restorable.
 */
function buildBackupPlan(records, { appVersion = null, now = Date.now() } = {}) {
  const list = Array.isArray(records) ? records : [];
  const used = new Set();
  const files = [];
  let characters = 0;
  for (const record of list) {
    if (!record || typeof record !== 'object') continue;
    const base = `meeting-${fileStamp(record.endedAt || record.startedAt)}-${shortId(record.id)}`;
    let name = `${base}.json`;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}-${suffix}.json`;
      suffix += 1;
    }
    used.add(name);
    const content = JSON.stringify(record, null, 2);
    characters += content.length;
    files.push({
      name,
      content,
      id: typeof record.id === 'string' ? record.id : null,
      endedAt: Number.isFinite(record.endedAt) ? record.endedAt : null,
      turnCount: Array.isArray(record.turns) ? record.turns.length : 0,
    });
  }
  const index = {
    kind: INDEX_KIND,
    version: 1,
    appVersion: appVersion ? String(appVersion).slice(0, 40) : null,
    createdAt: Number.isFinite(now) ? now : Date.now(),
    recordCount: files.length,
    records: files.map((file) => ({
      file: file.name,
      id: file.id,
      endedAt: file.endedAt,
      turnCount: file.turnCount,
    })),
  };
  return {
    files,
    index: { name: INDEX_NAME, content: JSON.stringify(index, null, 2) },
    count: files.length,
    characters,
  };
}

/**
 * Read a folder's worth of files back into records.
 *
 * `entries` are `{ name, text }` pairs, or `{ name, tooLarge: true }` when the
 * caller refused to read the bytes. Anything that is not a saved meeting is
 * named in `skipped` rather than passed on, and the index file is ignored
 * quietly because it is ours.
 */
function readBackupFolder(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const records = [];
  const skipped = [];
  let seen = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '');
    if (!/\.json$/i.test(name)) continue;
    if (seen >= MAX_BACKUP_FILES) {
      skipped.push({ name, reason: 'too_many_files' });
      continue;
    }
    seen += 1;
    if (entry.tooLarge) {
      skipped.push({ name, reason: 'file_too_large' });
      continue;
    }
    const text = String(entry.text || '');
    if (text.length > MAX_BACKUP_FILE_BYTES) {
      skipped.push({ name, reason: 'file_too_large' });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      skipped.push({ name, reason: 'not_json' });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped.push({ name, reason: 'not_a_record' });
      continue;
    }
    if (parsed.kind === INDEX_KIND) continue;
    if (parsed.version !== 1) {
      skipped.push({ name, reason: 'unsupported_version' });
      continue;
    }
    if (!Array.isArray(parsed.turns)) {
      skipped.push({ name, reason: 'no_turns' });
      continue;
    }
    records.push(parsed);
  }
  return { records, skipped };
}

module.exports = {
  INDEX_KIND,
  INDEX_NAME,
  MAX_BACKUP_FILES,
  MAX_BACKUP_FILE_BYTES,
  buildBackupPlan,
  readBackupFolder,
  fileStamp,
  shortId,
};
