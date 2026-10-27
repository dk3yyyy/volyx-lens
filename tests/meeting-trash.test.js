'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeetingStore, MAX_RECORDS } = require('../src/meeting-store');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

const DAY_MS = 24 * 60 * 60 * 1000;

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-lens-trash-'));
}

function save(store, text, endedAt) {
  return store.finalize({
    turns: [{ id: 1, channel: 'you', text, ts: endedAt - 1000 }],
    enabled: true,
    endedAt,
  });
}

test('delete moves the record to the trash instead of unlinking it', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const saved = save(store, 'The only copy of this meeting', 5000);
  const result = store.remove(saved.id);
  assert.equal(result.removed, true);
  assert.equal(result.trashed, true);
  assert.deepEqual(store.list(), [], 'the meeting is gone from history');
  const trash = fs.readdirSync(`${directory}-trash`);
  assert.equal(trash.length, 1);
  assert.ok(trash[0].includes(saved.id), 'the trash file keeps the record id');
  const trashed = JSON.parse(fs.readFileSync(path.join(`${directory}-trash`, trash[0]), 'utf8'));
  assert.match(trashed.turns[0].text, /only copy/, 'the trashed file is the whole record');
});

test('restoring a deleted meeting puts it back in its own place in the list', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const first = save(store, 'First meeting', 1000);
  const second = save(store, 'Second meeting', 2000);
  const third = save(store, 'Third meeting', 3000);
  const order = store.list().map((record) => record.id);
  assert.deepEqual(order, [third.id, second.id, first.id], 'newest first');

  assert.equal(store.remove(second.id).removed, true);
  const restored = store.restoreDeleted([second.id]);
  assert.equal(restored.restored, 1);
  assert.deepEqual(restored.missing, []);
  assert.deepEqual(store.list().map((record) => record.id), order, 'the restored meeting is back in the middle, not on top');
  assert.match(store.get(second.id).turns[0].text, /Second meeting/);
});

test('restoring an id with nothing in the trash reports it as missing', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const result = store.restoreDeleted(['ffffffff-5555-4555-8555-555555555555', '../../etc/passwd']);
  assert.equal(result.restored, 0);
  assert.deepEqual(result.missing, ['ffffffff-5555-4555-8555-555555555555'], 'an unsafe id is dropped, a missing one is named');
});

test('deleted meetings are purged from the trash after the retention window', () => {
  const directory = temporaryDirectory();
  let clock = 1_000_000;
  const store = createMeetingStore({ dir: directory, now: () => clock });
  const saved = save(store, 'Deleted a month ago', 5000);
  store.remove(saved.id);

  clock += 10 * DAY_MS;
  assert.equal(store.purgeTrash().removed, 0, 'a fresh delete survives');
  assert.equal(fs.readdirSync(`${directory}-trash`).length, 1);

  clock += 21 * DAY_MS;
  assert.equal(store.purgeTrash().removed, 1, 'past the window the copy goes');
  assert.deepEqual(fs.readdirSync(`${directory}-trash`), []);
  assert.equal(store.restoreDeleted([saved.id]).restored, 0, 'nothing left to restore');
});

test('clearing history is permanent and takes the undo copies with it', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const deleted = save(store, 'Deleted earlier', 1000);
  store.remove(deleted.id);
  save(store, 'Still in history', 2000);
  assert.equal(fs.readdirSync(`${directory}-trash`).length, 1);

  const result = store.clear();
  assert.equal(result.cleared, 1);
  assert.equal(result.trashCleared, 1);
  assert.deepEqual(fs.readdirSync(`${directory}-trash`), [], 'clear all leaves no copy behind');
  assert.equal(store.restoreDeleted([deleted.id]).restored, 0);
});

test('a restore into a full history is refused and reported, not silently pruned', () => {
  const directory = temporaryDirectory();
  const store = createMeetingStore({ dir: directory });
  const saved = save(store, 'Meeting kept for later', 1000);
  store.remove(saved.id);
  for (let i = 0; i < MAX_RECORDS; i += 1) {
    save(store, `Filler meeting ${i}`, 2000 + i);
  }
  const restored = store.restoreDeleted([saved.id]);
  assert.equal(restored.restored, 0, 'nothing is restored into a full store');
  assert.equal(restored.blocked, 1, 'the refusal is reported so the pane can say why');
  assert.equal(store.list().length, MAX_RECORDS, 'the cap still holds');
  assert.equal(fs.readdirSync(`${directory}-trash`).length, 1, 'the copy stays in the trash for later');
});

test('the trash reports what is still restorable after a relaunch', () => {
  const directory = temporaryDirectory();
  let clock = 1_000_000;
  const store = createMeetingStore({ dir: directory, now: () => clock });
  const first = save(store, 'First deleted', 1000);
  clock += 1000;
  const second = save(store, 'Second deleted', 2000);
  store.remove(first.id);
  clock += 1000;
  store.remove(second.id);
  const ids = store.trashIds();
  assert.equal(ids.length, 2);
  assert.equal(ids[0], second.id, 'newest deletion first');
  // A second store over the same folder sees the same copies, so the window does
  // not depend on the session that did the deleting.
  const reopened = createMeetingStore({ dir: directory });
  assert.deepEqual(reopened.trashIds(), ids);
  assert.equal(reopened.restoreDeleted(ids).restored, 2);
});

test('undo is wired through the pane, the bridge and the main process', () => {
  assert.match(main, /handleTrusted\('history:undo-delete'/);
  assert.match(main, /restoreDeleted\(/);
  assert.match(main, /purgeTrash\(/);
  assert.match(preload, /historyUndoDelete: \(ids\) => ipcRenderer\.invoke\('history:undo-delete'/);
  assert.match(main, /handleTrusted\('history:restore-trash'/);
  assert.match(preload, /historyRestoreTrash: \(\) => ipcRenderer\.invoke\('history:restore-trash'\)/);
  assert.ok(html.includes('id="meeting-history-restore-trash"'), 'the pane can restore after a relaunch');
  assert.ok(html.includes('id="meeting-history-undo"'), 'the pane offers the undo control');
  assert.match(renderer, /You can undo this right after/);
  assert.match(renderer, /Clear all is permanent|permanently removes/);
});
