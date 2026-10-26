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

test('updateCleaned stores a parallel cleaned copy without touching raw turns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({
    turns: [
      { id: 1, channel: 'them', text: 'so the vee four pro is going away', ts: 1000 },
      { id: 2, channel: 'you', text: 'right the flash model stays', ts: 2000 },
    ],
    enabled: true,
    reason: 'capture-stop',
  });
  const before = store.get(saved.id);
  const result = store.updateCleaned(saved.id, {
    version: 1,
    at: 1700000000000,
    model: 'deepseek-flash',
    turns: [
      { channel: 'them', text: 'So the V4 Pro is going away.', ts: 1000 },
      { channel: 'you', text: 'Right, the Flash model stays.', ts: 2000 },
    ],
  });
  assert.equal(result.updated, true);
  const after = store.get(saved.id);
  assert.deepStrictEqual(after.turns, before.turns, 'raw turns are byte-identical after cleaning');
  assert.equal(after.cleaned.turns.length, 2);
  assert.equal(after.cleaned.turns[0].text, 'So the V4 Pro is going away.');
  assert.equal(after.cleaned.model, 'deepseek-flash');
  store.clear();
});

test('updateCleaned refuses a copy whose turn count does not match the record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({
    turns: [{ channel: 'you', text: 'Hello world', ts: 1000 }, { channel: 'them', text: 'Hi there', ts: 2000 }],
    enabled: true,
    reason: 'capture-stop',
  });
  const result = store.updateCleaned(saved.id, {
    version: 1,
    turns: [{ channel: 'you', text: 'Hello world.', ts: 1000 }],
  });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'turn_count_mismatch');
  assert.equal(store.get(saved.id).cleaned, null);
  store.clear();
});

test('updateCleaned rejects unsafe ids and missing records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  assert.equal(store.updateCleaned('../etc/passwd', { turns: [] }).updated, false);
  assert.equal(store.updateCleaned('does-not-exist', { turns: [] }).updated, false);
  store.clear();
});

test('list() reports hasCleaned and notes and cleaned copies coexist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({
    turns: [{ channel: 'you', text: 'Hello world', ts: 1000 }],
    enabled: true,
    reason: 'capture-stop',
  });
  assert.equal(store.list()[0].hasCleaned, false);
  store.updateNotes(saved.id, { summary: 'S', keyPoints: [], decisions: [], actionItems: [], followUp: [] });
  store.updateCleaned(saved.id, { version: 1, turns: [{ channel: 'you', text: 'Hello, world.', ts: 1000 }] });
  const listed = store.list()[0];
  assert.equal(listed.hasCleaned, true);
  assert.equal(Boolean(listed.hasNotes), true);
  const record = store.get(saved.id);
  assert.equal(record.cleaned.turns[0].text, 'Hello, world.');
  assert.equal(record.notes.summary, 'S', 'writing a cleaned copy preserves the notes');
  store.updateNotes(saved.id, { summary: 'S2', keyPoints: [], decisions: [], actionItems: [], followUp: [] });
  assert.equal(store.get(saved.id).cleaned.turns[0].text, 'Hello, world.', 'writing notes preserves the cleaned copy');
  store.clear();
});

test('updateCleaned normalises speaker, caps text length, and stamps nothing it was not given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({
    turns: [{ channel: 'them', text: 'Hi', ts: 1000 }],
    enabled: true,
    reason: 'capture-stop',
  });
  const long = 'x'.repeat(20000);
  store.updateCleaned(saved.id, { turns: [{ channel: 'someone', text: long, ts: 1000 }] });
  const cleaned = store.get(saved.id).cleaned;
  assert.equal(cleaned.turns[0].channel, 'them');
  assert.equal(cleaned.turns[0].text.length, 12000);
  assert.equal(cleaned.turns[0].ts, 1000);
  store.clear();
});
