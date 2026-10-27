'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMeetingStore } = require('../src/meeting-store');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-append-'));
}

function turn(id, text, ts, channel = 'you') {
  return { id, channel, text, ts };
}

test('stopping and starting again appends to the same meeting', () => {
  const dir = temporaryDirectory();
  const store = createMeetingStore({ dir });
  const first = store.finalize({
    turns: [turn(1, 'first half', 1000), turn(2, 'still first half', 2000)],
    enabled: true,
    reason: 'capture-stop',
    startedAt: 1000,
    endedAt: 2500,
  });
  assert.equal(first.saved, true);

  const second = store.finalize({
    turns: [turn(1, 'second half', 9000), turn(2, 'still second half', 9500)],
    enabled: true,
    reason: 'capture-stop',
    startedAt: 9000,
    endedAt: 9800,
    recordId: first.id,
  });

  assert.equal(second.saved, true);
  assert.equal(second.appended, true);
  assert.equal(second.id, first.id, 'the same record is reused');
  const listed = store.list();
  assert.equal(listed.length, 1, 'one meeting, one row');
  const record = store.get(first.id);
  assert.equal(record.turns.length, 4, 'the turns are the union of both halves');
  assert.deepEqual(record.turns.map((entry) => entry.text), ['first half', 'still first half', 'second half', 'still second half']);
  assert.equal(record.startedAt, 1000, 'the meeting still starts when it started');
  assert.equal(record.endedAt, 9800, 'and ends at the later stop');
});

test('re-saving the same turns appends nothing', () => {
  const dir = temporaryDirectory();
  const store = createMeetingStore({ dir });
  const first = store.finalize({ turns: [turn(1, 'only turn', 1000)], enabled: true, reason: 'capture-stop' });
  const again = store.finalize({ turns: [turn(1, 'only turn', 1000)], enabled: true, reason: 'capture-stop', recordId: first.id });
  assert.equal(again.saved, false);
  assert.equal(again.reason, 'no_new_content');
  assert.equal(store.get(first.id).turns.length, 1, 'no duplicate turn');
});

test('an appended turn keeps the record readable and prunable', () => {
  const dir = temporaryDirectory();
  const store = createMeetingStore({ dir });
  const first = store.finalize({ turns: [turn(1, 'a', 1000)], enabled: true, reason: 'capture-stop' });
  store.finalize({ turns: [turn(2, 'b', 2000)], enabled: true, reason: 'capture-stop', recordId: first.id });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${first.id}.json`), 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.turnCount, 2);
  assert.equal(onDisk.turns.length, 2);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false, 'no temp file left behind');
});

test('a record that was deleted meanwhile becomes a new record instead of losing turns', () => {
  const dir = temporaryDirectory();
  const store = createMeetingStore({ dir });
  const first = store.finalize({ turns: [turn(1, 'a', 1000)], enabled: true, reason: 'capture-stop' });
  store.remove(first.id);
  const afterDelete = store.finalize({ turns: [turn(1, 'b', 2000)], enabled: true, reason: 'capture-stop', recordId: first.id });
  assert.equal(afterDelete.saved, true);
  assert.notEqual(afterDelete.id, first.id, 'a fresh record is written');
  assert.equal(store.get(afterDelete.id).turns.length, 1);
});

test('the runner tracks the open record and lets go of it at a session boundary', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /let activeMeetingRecordId = null;/);
  assert.match(main, /recordId: activeMeetingRecordId,/);
  assert.match(main, /if \(result\.saved && result\.id\) activeMeetingRecordId = result\.id;/);
  assert.match(main, /if \(reason === 'new-session'\) activeMeetingRecordId = null;/);
  const clearHandler = main.slice(main.indexOf("handleTrusted('transcript:clear'"), main.indexOf("handleTrusted('transcript:export'"));
  assert.match(clearHandler, /resetTranscriptData\(\);\s*\n\s*chatHistory\.clear\(\);\s*\n[\s\S]*?activeMeetingRecordId = null;/, 'clearing the transcript starts a new meeting');
});
