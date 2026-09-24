const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { createMeetingStore } = require('../src/meeting-store');

test('createMeetingStore finalizes and retrieves a meeting record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const result = store.finalize({
    turns: [{ channel: 'you', text: 'Hello world', ts: 1000 }],
    enabled: true,
    reason: 'capture-stop',
  });
  assert.ok(result.saved);
  const record = store.get(result.id);
  assert.ok(record);
  assert.equal(record.turns.length, 1);
  store.clear();
});

test('updateNotes persists structured notes to a meeting record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const result = store.finalize({
    turns: [{ channel: 'you', text: 'Hello world', ts: 1000 }],
    enabled: true,
    reason: 'capture-stop',
  });
  assert.ok(result.saved);
  const notes = { summary: 'Test summary', keyPoints: ['Point 1'], decisions: [], actionItems: ['Action 1'], followUp: [] };
  const updateResult = store.updateNotes(result.id, notes);
  assert.ok(updateResult.updated);
  const record = store.get(result.id);
  assert.deepStrictEqual(record.notes, notes);
  const list = store.list();
  assert.ok(list[0].hasNotes);
  store.clear();
});

test('list() correctly reports hasNotes=false when no notes exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  store.finalize({
    turns: [{ channel: 'you', text: 'Hello', ts: 1000 }],
    enabled: true,
  });
  const list = store.list();
  assert.ok(!list[0].hasNotes);
  store.clear();
});
