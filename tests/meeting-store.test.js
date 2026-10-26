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
    texts: ['So the V4 Pro is going away.', 'Right, the Flash model stays.'],
  });
  assert.equal(result.updated, true);
  const after = store.get(saved.id);
  assert.deepStrictEqual(after.turns, before.turns, 'raw turns are byte-identical after cleaning');
  assert.equal(after.cleaned.texts.length, 2);
  assert.equal(after.cleaned.texts[0], 'So the V4 Pro is going away.');
  assert.equal(after.cleaned.model, 'deepseek-flash');
  assert.match(after.cleaned.sourceHash, /^[0-9a-f]{64}$/);
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
    texts: ['Hello world.'],
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
  store.updateCleaned(saved.id, { version: 1, texts: ['Hello, world.'] });
  const listed = store.list()[0];
  assert.equal(listed.hasCleaned, true);
  assert.equal(Boolean(listed.hasNotes), true);
  const record = store.get(saved.id);
  assert.equal(record.cleaned.texts[0], 'Hello, world.');
  assert.equal(record.notes.summary, 'S', 'writing a cleaned copy preserves the notes');
  store.updateNotes(saved.id, { summary: 'S2', keyPoints: [], decisions: [], actionItems: [], followUp: [] });
  assert.equal(store.get(saved.id).cleaned.texts[0], 'Hello, world.', 'writing notes preserves the cleaned copy');
  store.clear();
});

test('updateCleaned stores text only, caps length, rejects source drift and blank lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({
    turns: [{ channel: 'them', text: 'Hi', ts: 1000 }],
    enabled: true,
    reason: 'capture-stop',
  });
  const long = 'x'.repeat(20000);
  store.updateCleaned(saved.id, { texts: [long] });
  const cleaned = store.get(saved.id).cleaned;
  assert.equal(cleaned.texts[0].length, 12000);
  assert.equal('turns' in cleaned, false, 'no speaker or timestamp is stored with the cleaned text');
  assert.equal(store.get(saved.id).turns[0].channel, 'them');
  assert.equal(store.get(saved.id).turns[0].ts, 1000);

  assert.equal(store.updateCleaned(saved.id, { texts: ['   '] }).reason, 'empty_text');
  assert.equal(store.updateCleaned(saved.id, { texts: ['Hi there.'], sourceHash: 'deadbeef' }).reason, 'source_changed');
  store.clear();
});

test('cleaning an older meeting does not reorder history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const older = store.finalize({ turns: [{ channel: 'you', text: 'first meeting transcript', ts: 1 }], enabled: true });
  const newer = store.finalize({ turns: [{ channel: 'you', text: 'second meeting transcript', ts: 2 }], enabled: true });
  const before = store.list().map((record) => record.id);
  store.updateCleaned(older.id, { texts: ['First meeting transcript.'] });
  const after = store.list().map((record) => record.id);
  assert.deepEqual(after, before, 'a derived write keeps the record in its place');
  assert.ok(after.includes(newer.id));
  store.clear();
});

test('updateNotes writes through a temp file and keeps the record where it was', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const calls = [];
  const fsImpl = {
    ...fs,
    writeFileSync: (file, data, options) => { calls.push(['write', file]); return fs.writeFileSync(file, data, options); },
    renameSync: (from, to) => { calls.push(['rename', from, to]); return fs.renameSync(from, to); },
    utimesSync: (...args) => { calls.push(['utimes', args[0]]); return fs.utimesSync(...args); },
  };
  const store = createMeetingStore({ dir, fsImpl });
  const saved = store.finalize({ turns: [{ channel: 'you', text: 'Hello world', ts: 1000 }], enabled: true });
  const target = path.join(dir, `${saved.id}.json`);
  const mtimeBefore = fs.statSync(target).mtimeMs;
  calls.length = 0;

  const result = store.updateNotes(saved.id, { summary: 'S', keyPoints: [], decisions: [], actionItems: [], followUp: [] });
  assert.equal(result.updated, true);

  const writes = calls.filter((call) => call[0] === 'write').map((call) => call[1]);
  assert.deepEqual(writes, [`${target}.tmp`], 'the live record is never written in place');
  assert.deepEqual(calls.find((call) => call[0] === 'rename'), ['rename', `${target}.tmp`, target]);
  assert.equal(fs.existsSync(`${target}.tmp`), false, 'the temp file does not survive');
  assert.equal(fs.statSync(target).mtimeMs, mtimeBefore, 'a derived write does not reorder history');
  assert.equal(store.get(saved.id).notes.summary, 'S');
  store.clear();
});

test('a failed notes write leaves the previous record readable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  let failRename = false;
  const fsImpl = {
    ...fs,
    renameSync: (from, to) => {
      if (failRename && to.endsWith('.json')) { failRename = false; throw new Error('disk full'); }
      return fs.renameSync(from, to);
    },
  };
  const store = createMeetingStore({ dir, fsImpl });
  const saved = store.finalize({ turns: [{ channel: 'you', text: 'Hello world', ts: 1000 }], enabled: true });
  failRename = true;
  const result = store.updateNotes(saved.id, { summary: 'S', keyPoints: [], decisions: [], actionItems: [], followUp: [] });
  assert.equal(result.updated, false);
  const record = store.get(saved.id);
  assert.ok(record, 'the record still parses');
  assert.equal(record.turns[0].text, 'Hello world');
  assert.equal(record.notes, null);
  store.clear();
});

test('a failed write leaves no meeting copy behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  let failRename = false;
  const fsImpl = {
    ...fs,
    renameSync: (from, to) => {
      if (failRename && to.endsWith('.json')) throw new Error('disk full');
      return fs.renameSync(from, to);
    },
  };
  const store = createMeetingStore({ dir, fsImpl });
  const saved = store.finalize({ turns: [{ channel: 'you', text: 'Hello world', ts: 1000 }], enabled: true });
  failRename = true;
  const result = store.updateNotes(saved.id, { summary: 'S', keyPoints: [], decisions: [], actionItems: [], followUp: [] });
  assert.equal(result.updated, false);
  assert.equal(fs.existsSync(path.join(dir, `${saved.id}.json.tmp`)), false, 'the temp copy is removed');
  store.clear();
});

test('orphaned temp files are swept by clear', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  store.finalize({ turns: [{ channel: 'you', text: 'Hello world', ts: 1000 }], enabled: true });
  fs.writeFileSync(path.join(dir, 'abandoned.json.tmp'), '{"partial":true}');
  const result = store.clear();
  assert.ok(result.cleared >= 1);
  assert.equal(fs.existsSync(path.join(dir, 'abandoned.json.tmp')), false);
});
