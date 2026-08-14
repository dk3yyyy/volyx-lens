'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeetingStore, snapshotTurns, fingerprint, isSafeId, MAX_RECORDS } = require('../src/meeting-store');
const { getDefaultSettings } = require('../src/provider-config');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const storeSrc = fs.readFileSync(path.join(root, 'src', 'store.js'), 'utf8');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-lens-meetings-'));
}

function sampleTurns(count = 3) {
  const turns = [];
  for (let i = 0; i < count; i += 1) {
    turns.push({ id: i + 1, channel: i % 2 ? 'them' : 'you', text: `Turn ${i + 1}`, ts: 1000 + i });
  }
  return turns;
}

test('history is opt-in: disabled finalize never writes a file', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: path.join(directory, 'meetings') });
  const result = store.finalize({ turns: sampleTurns(), enabled: false });
  assert.deepEqual(result, { saved: false, reason: 'disabled' });
  assert.equal(fs.existsSync(path.join(directory, 'meetings')), false);
  assert.deepEqual(store.list(), []);
});

test('empty transcripts are skipped', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  assert.deepEqual(store.finalize({ turns: [], enabled: true }), { saved: false, reason: 'empty' });
  assert.deepEqual(store.finalize({ turns: [{ text: '   ' }], enabled: true }), { saved: false, reason: 'empty' });
  assert.deepEqual(store.list(), []);
});

test('finalize writes an atomic 0600 record and list/get round-trip it', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const result = store.finalize({ turns: sampleTurns(), enabled: true, reason: 'capture-stop', startedAt: 500, endedAt: 2000 });
  assert.equal(result.saved, true);
  assert.equal(result.turnCount, 3);
  assert.match(result.id, /^[0-9a-f-]{36}$/);

  const file = path.join(directory, `${result.id}.json`);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.reason, 'capture-stop');
  assert.equal(persisted.startedAt, 500);
  assert.equal(persisted.endedAt, 2000);
  assert.equal(persisted.turnCount, 3);
  assert.equal(persisted.turns.length, 3);
  assert.equal(persisted.turns[0].text, 'Turn 1');

  assert.deepEqual(store.list(), [{ id: result.id, reason: 'capture-stop', startedAt: 500, endedAt: 2000, turnCount: 3 }]);
  assert.equal(store.get(result.id).turns.length, 3);
  assert.equal(store.get(result.id).turns[2].text, 'Turn 3');
});

test('finalize is idempotent: identical transcript is not written twice', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const turns = sampleTurns();
  const first = store.finalize({ turns, enabled: true });
  assert.equal(first.saved, true);
  const second = store.finalize({ turns, enabled: true });
  assert.deepEqual(second, { saved: false, reason: 'no_new_content' });
  assert.equal(store.list().length, 1);
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.json')).length, 1);

  const grown = store.finalize({ turns: [...turns, { id: 4, channel: 'you', text: 'Turn 4', ts: 4000 }], enabled: true });
  assert.equal(grown.saved, true);
  assert.equal(store.list().length, 2);
});

test('remove and clear delete records', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const first = store.finalize({ turns: sampleTurns(2), enabled: true });
  const second = store.finalize({ turns: sampleTurns(4), enabled: true });
  assert.deepEqual(store.remove(first.id), { removed: true });
  assert.deepEqual(store.remove(first.id), { removed: false });
  assert.equal(store.get(first.id), null);
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.clear(), { cleared: 1 });
  assert.deepEqual(store.list(), []);
});

test('unsafe ids are rejected and cannot traverse outside the directory', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  for (const id of ['..', '.', '../../etc/passwd', 'a/b', 'a\\b', '', ' ', 'a'.repeat(200)]) {
    assert.equal(isSafeId(id), false);
    assert.throws(() => store.get(id), /Invalid meeting id/);
    assert.throws(() => store.remove(id), /Invalid meeting id/);
  }
  assert.equal(isSafeId('1f4c0f2d-4b7a-4f8a-9b0e-3c2f1d0a5e6b'), true);
  assert.equal(fs.readdirSync(directory).length, 0);
});

test('corrupt and non-record files are skipped by list and get', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  fs.writeFileSync(path.join(directory, 'junk.json'), 'not json at all');
  fs.writeFileSync(path.join(directory, 'other.txt'), 'ignored');
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('junk'), null);
});

test('prune keeps at most MAX_RECORDS, oldest records removed first', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const firstIds = [];
  for (let i = 0; i < MAX_RECORDS + 5; i += 1) {
    const result = store.finalize({
      turns: [{ id: i + 1, channel: 'you', text: `Meeting ${i + 1}`, ts: 1000 + i }],
      enabled: true,
      endedAt: 2000 + i,
    });
    assert.equal(result.saved, true);
    if (i < 5) firstIds.push(result.id);
  }
  const records = store.list();
  assert.equal(records.length, MAX_RECORDS);
  const remaining = new Set(records.map((record) => record.id));
  for (const id of firstIds) assert.equal(remaining.has(id), false);
});

test('snapshotTurns normalizes channels, drops blank text, and caps turn count', () => {
  const normalized = snapshotTurns([
    { id: 1, channel: 'you', text: 'hello', ts: 1 },
    { id: 2, channel: 'them', text: '   ', ts: 2 },
    { text: 'world', ts: 3 },
    { id: 4, channel: 'unknown', text: 'other', ts: 4 },
    null,
  ]);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].channel, 'you');
  assert.equal(normalized[1].channel, 'them');
  assert.equal(normalized[2].channel, 'them');
  assert.equal(fingerprint([]), null);
  const fp = fingerprint([{ id: 7, channel: 'you', text: 'x', ts: 9 }]);
  assert.deepEqual(fp, { count: 1, lastId: 7, lastTs: 9 });
});

test('history is opt-in by default and sanitized only as a boolean', () => {
  assert.equal(getDefaultSettings().transcription.historyEnabled, false);
  assert.match(storeSrc, /historyEnabled'\) && typeof value\.historyEnabled === 'boolean'/);
});

test('settings UI exposes the history toggle and persists it', () => {
  assert.match(html, /id="stt-history-enabled"[^>]*type="checkbox"/);
  assert.match(html, /Off by default\. When enabled, each finalized session/);
  assert.match(renderer, /\$\('#stt-history-enabled'\)\.checked = transcription\.historyEnabled === true/);
  assert.match(renderer, /historyEnabled: \$\('#stt-history-enabled'\)\.checked/);
});

test('main process wires the store, finalize points, and trusted IPC', () => {
  assert.match(main, /const \{ createMeetingStore \} = require\('\.\/src\/meeting-store'\)/);
  assert.match(main, /createMeetingStore\(\{ dir: path\.join\(currentUserDataPath, 'meetings'\) \}\)/);
  assert.match(main, /function finalizeMeeting\(reason = 'capture-stop'/);
  assert.match(main, /historyEnabled/);
  assert.match(main, /finalizeMeeting\('new-session'\)/);
  assert.match(main, /finalizeMeeting\('app-quit'\)/);
  assert.match(main, /finalizeMeeting\(reason \|\| 'capture-stop', \{ startedAt: captureStartedAtEnd/);
  assert.match(main, /reason !== 'suspend' && reason !== 'lock'/);
  for (const channel of ['history:list', 'history:get', 'history:delete', 'history:clear']) {
    assert.match(main, new RegExp(`handleTrusted\\('${channel}'`));
  }
  assert.match(main, /send\('history:changed'/);
  for (const method of ['historyList', 'historyGet', 'historyDelete', 'historyClear']) {
    assert.match(preload, new RegExp(`${method}: \\(.*ipcRenderer\\.invoke\\('history:`));
  }
  assert.match(preload, /'history:changed'/);
});