'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildBackupPlan,
  readBackupFolder,
  INDEX_NAME,
  MAX_BACKUP_FILES,
  fileStamp,
} = require('../src/meeting-backup');
const { createMeetingStore } = require('../src/meeting-store');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-lens-backup-'));
}

function sampleRecord(overrides = {}) {
  const endedAt = overrides.endedAt || 1_700_000_000_000;
  return {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    version: 1,
    reason: 'capture-stop',
    meeting: true,
    startedAt: endedAt - 60_000,
    endedAt,
    turnCount: 2,
    turns: [
      { id: 1, channel: 'you', text: 'We should ship the roadmap.', ts: endedAt - 5000 },
      { id: 2, channel: 'them', text: 'Agreed, next Tuesday works.', ts: endedAt - 2000 },
    ],
    participant: 'Priya',
    notes: { summary: 'Ship the roadmap', sourceHash: null },
    cleaned: null,
    ...overrides,
  };
}

test('buildBackupPlan writes one file per saved meeting plus an index', () => {
  const records = [
    sampleRecord(),
    sampleRecord({ id: 'bbbbbbbb-2222-4222-8222-222222222222', endedAt: 1_700_000_060_000 }),
  ];
  const plan = buildBackupPlan(records, { appVersion: '0.7.3', now: 1_700_000_100_000 });
  assert.equal(plan.files.length, 2);
  assert.equal(plan.count, 2);
  assert.equal(plan.index.name, INDEX_NAME);
  for (const file of plan.files) {
    assert.match(file.name, /^meeting-\d{4}-\d{2}-\d{2}-\d{4}-[0-9a-z]{8}\.json$/);
    const parsed = JSON.parse(file.content);
    assert.deepEqual(parsed.turns, records.find((record) => record.id === parsed.id).turns, 'the raw turns are copied, not summarised');
  }
  const index = JSON.parse(plan.index.content);
  assert.equal(index.recordCount, 2);
  assert.equal(index.appVersion, '0.7.3');
  assert.deepEqual(index.records.map((entry) => entry.file).sort(), plan.files.map((file) => file.name).sort());
  assert.ok(plan.characters > 0);
});

test('buildBackupPlan keeps two records from the same minute apart', () => {
  const twinA = sampleRecord({ id: 'dddddddd-4444-4444-8444-444444444444', endedAt: 1_700_000_000_000 });
  const twinB = sampleRecord({ id: 'dddddddd-4444-4444-8444-444444444444', endedAt: 1_700_000_000_000 });
  const plan = buildBackupPlan([twinA, twinB]);
  assert.equal(plan.files.length, 2);
  assert.notEqual(plan.files[0].name, plan.files[1].name, 'two meetings in one minute get distinct files');
  assert.match(plan.files[1].name, /-2\.json$/);
  assert.equal(fileStamp(1e20), '0000-00-00', 'a date that cannot be represented still produces a name');
});

test('readBackupFolder stops reading past its file ceiling', () => {
  const entries = [];
  for (let i = 0; i < MAX_BACKUP_FILES + 2; i += 1) {
    entries.push({ name: `record-${i}.json`, text: JSON.stringify(sampleRecord({ id: `id-${i}` })) });
  }
  const result = readBackupFolder(entries);
  assert.equal(result.records.length, MAX_BACKUP_FILES);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['too_many_files', 'too_many_files']);
});

test('a plan read back through readBackupFolder returns the same records', () => {
  const records = [sampleRecord(), sampleRecord({ id: 'cccccccc-3333-4333-8333-333333333333' })];
  const plan = buildBackupPlan(records, { appVersion: '0.7.3' });
  const entries = plan.files.map((file) => ({ name: file.name, text: file.content }));
  entries.push({ name: plan.index.name, text: plan.index.content });
  entries.push({ name: 'notes.txt', text: 'not a record' });
  const result = readBackupFolder(entries);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((record) => record.id).sort(), records.map((record) => record.id).sort());
  assert.deepEqual(result.skipped, [], 'the index and unrelated files are ignored, not reported as damage');
});

test('readBackupFolder names every file it refuses instead of importing it', () => {
  const result = readBackupFolder([
    { name: 'broken.json', text: '{ not json' },
    { name: 'old.json', text: JSON.stringify({ id: 'x', version: 2, turns: [] }) },
    { name: 'shape.json', text: JSON.stringify({ id: 'y', version: 1 }) },
    { name: 'list.json', text: JSON.stringify([1, 2, 3]) },
    { name: 'huge.json', tooLarge: true },
  ]);
  assert.equal(result.records.length, 0);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), [
    'not_json',
    'unsupported_version',
    'no_turns',
    'not_a_record',
    'file_too_large',
  ]);
});

test('importRecords restores turns, speaker, notes and the cleaned copy', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const source = sampleRecord({
    cleaned: {
      version: 1,
      at: 1_700_000_050_000,
      model: 'deepseek-flash',
      provider: 'deepseek',
      texts: ['We should ship the roadmap.', 'Agreed, next Tuesday works.'],
    },
  });
  const result = store.importRecords([source]);
  assert.equal(result.imported, 1);
  assert.deepEqual(result.skipped, []);
  const restored = store.get(result.ids[0]);
  assert.ok(restored, 'the record is readable after import');
  assert.deepEqual(restored.turns.map((turn) => turn.text), source.turns.map((turn) => turn.text));
  assert.deepEqual(restored.turns.map((turn) => turn.channel), ['you', 'them']);
  assert.equal(restored.participant, 'Priya');
  assert.match(restored.notes.summary, /Ship the roadmap/);
  assert.deepEqual(restored.cleaned.texts, source.cleaned.texts);
  assert.equal(restored.endedAt, source.endedAt, 'the meeting keeps its own end time');
});

test('importRecords skips an empty transcript and never overwrites a newer meeting', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const saved = store.finalize({
    turns: [{ id: 1, channel: 'you', text: 'The meeting saved after the backup', ts: 1000 }],
    enabled: true,
    endedAt: 5000,
  });
  const incoming = {
    id: saved.id,
    version: 1,
    turns: [{ id: 1, channel: 'you', text: 'Older wording from the backup', ts: 1000 }],
    endedAt: 4000,
  };
  const result = store.importRecords([incoming, { id: 'empty', version: 1, turns: [] }]);
  assert.equal(result.imported, 1, 'the record with turns is imported');
  assert.equal(result.ids[0] === saved.id, false, 'the colliding id is replaced instead of overwriting');
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['empty_transcript']);
  assert.match(store.get(saved.id).turns[0].text, /saved after the backup/, 'the newer saved meeting is untouched');
  assert.equal(store.list().length, 2);
});

test('a restore that does not fit is refused instead of destroying what it restored', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const now = 1_700_000_000_000;
  for (let i = 0; i < store.maxRecords; i += 1) {
    store.finalize({
      turns: [{ id: 1, channel: 'you', text: `filler ${i}`, ts: now }],
      enabled: true,
      endedAt: now - (i * 1000),
    });
  }
  const before = store.list().map((record) => record.id).sort();
  const older = Array.from({ length: 10 }, (_, i) => ({
    id: `old-meeting-${i}`,
    version: 1,
    turns: [{ id: 1, channel: 'you', text: `old meeting ${i}`, ts: now }],
    endedAt: now - (365 * 24 * 60 * 60 * 1000) - i,
  }));
  const result = store.importRecords(older);
  assert.equal(result.imported, 0, 'nothing is reported as restored');
  assert.equal(result.blocked, 10, 'the refusal is reported so the pane can explain it');
  assert.equal(result.capacity, 0);
  assert.deepEqual(store.list().map((record) => record.id).sort(), before, 'the store is untouched');
  for (const record of older) assert.equal(store.get(record.id), null, `${record.id} was not written`);
});

test('a restore that fits fills the free slots and every restored record survives', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const now = 1_700_000_000_000;
  for (let i = 0; i < store.maxRecords - 5; i += 1) {
    store.finalize({
      turns: [{ id: 1, channel: 'you', text: `filler ${i}`, ts: now }],
      enabled: true,
      endedAt: now - (i * 1000),
    });
  }
  const older = Array.from({ length: 5 }, (_, i) => ({
    id: `old-meeting-${i}`,
    version: 1,
    turns: [{ id: 1, channel: 'you', text: `old meeting ${i}`, ts: now }],
    endedAt: now - (365 * 24 * 60 * 60 * 1000) - i,
  }));
  const result = store.importRecords(older);
  assert.equal(result.imported, 5);
  assert.equal(result.pruned, 0);
  const listed = new Set(store.list().map((record) => record.id));
  for (const record of older) assert.ok(listed.has(record.id), `${record.id} survived the restore`);
  assert.equal(
    result.imported,
    older.filter((record) => listed.has(record.id)).length,
    'the reported count is what is actually in the store, not how many were attempted',
  );
});

test('a backup with unreadable entries still fits when the readable ones do', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  for (let i = 0; i < store.maxRecords - 2; i += 1) {
    store.finalize({
      turns: [{ id: 1, channel: 'you', text: `filler ${i}`, ts: 1000 }],
      enabled: true,
      endedAt: 1000 + i,
    });
  }
  const result = store.importRecords([
    { id: 'good-1', version: 1, turns: [{ id: 1, channel: 'you', text: 'kept', ts: 1 }], endedAt: 5 },
    { id: 'good-2', version: 1, turns: [{ id: 1, channel: 'you', text: 'kept too', ts: 1 }], endedAt: 6 },
    { id: 'empty', version: 1, turns: [] },
  ]);
  assert.equal(result.imported, 2, 'the two readable records fit in the two free slots');
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['empty_transcript']);
  assert.equal(result.blocked, 0);
});

test('backup and restore are wired through the app, not only the module', () => {
  assert.match(main, /require\('\.\/src\/meeting-backup'\)/);
  assert.match(main, /async function backupAllMeetings\(/);
  assert.match(main, /async function restoreAllMeetings\(/);
  assert.match(main, /handleTrusted\('history:backup-all'/);
  assert.match(main, /handleTrusted\('history:restore-all'/);
  // Restoring writes saved meetings, so it is refused while history is off.
  assert.match(main, /Turn on Save meeting history in Settings before restoring a backup/);
  // The counts are known only after the folder is read, so the confirmation
  // happens in the main process with the real numbers in it.
  assert.match(main, /dialog\.showMessageBox\(/);
  // The capacity check runs before the confirm dialog, and a refusal is named.
  assert.match(main, /const capacity = Math\.max\(0, meetingStore\.maxRecords - existing\)/);
  assert.match(main, /if \(parsed\.records\.length > capacity\)/);
  assert.match(main, /Not enough room to restore \$\{parsed\.records\.length\} saved meetings\./);
  assert.match(renderer, /Not enough room: \$\{blocked\}/);
  assert.match(preload, /historyBackupAll: \(\) => ipcRenderer\.invoke\('history:backup-all'\)/);
  assert.match(preload, /historyRestoreAll: \(\) => ipcRenderer\.invoke\('history:restore-all'\)/);
});
