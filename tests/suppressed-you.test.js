const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { appendConversationSegment } = require('../src/transcript-grouping');
const {
  findSuppressedYouIndex,
  normalizeSuppressedYouSegments,
  restoreSuppressedYouSegment,
  MAX_SUPPRESSED_YOU_SEGMENTS,
} = require('../src/suppressed-you');

const root = path.resolve(__dirname, '..');

function conversation() {
  const turns = [];
  let turnId = 0;
  let segmentId = 0;
  const append = (channel, text, ts) => appendConversationSegment(turns, {
    id: ++segmentId, channel, text, ts,
  }, () => ++turnId);
  append('them', 'Their question.', 10);
  append('you', 'My first answer.', 20);
  append('you', 'My continuation.', 30);
  append('them', 'Their follow-up.', 40);
  return { turns, nextSegmentId: () => ++segmentId, nextTurnId: () => ++turnId };
}

test('restoring a suppressed You line reinserts its segment in timestamp order', () => {
  const { turns, nextSegmentId, nextTurnId } = conversation();
  const originalIds = turns.map((turn) => turn.id);

  const { turn, updated } = restoreSuppressedYouSegment(turns, {
    id: 'suppressed-1', text: 'Restored middle sentence.', ts: 25,
  }, { segmentId: nextSegmentId(), createTurnId: nextTurnId });

  assert.equal(updated, true);
  assert.equal(turn.id, originalIds[1]);
  assert.deepEqual(turns.map((entry) => entry.id), originalIds);
  assert.deepEqual(turns.map((entry) => entry.ts), [10, 20, 40]);
  assert.equal(turn.text, 'My first answer. Restored middle sentence. My continuation.');
  assert.deepEqual(turn.segments.map((entry) => entry.ts), [20, 25, 30]);
  assert.ok(turn.segments.every((entry) => entry.turnId === turn.id));
});

test('restoring before or after existing turns keeps the transcript chronological', () => {
  const { turns, nextSegmentId, nextTurnId } = conversation();
  restoreSuppressedYouSegment(turns, { text: 'Before everything.', ts: 5 }, { segmentId: nextSegmentId(), createTurnId: nextTurnId });
  restoreSuppressedYouSegment(turns, { text: 'After everything.', ts: 50 }, { segmentId: nextSegmentId(), createTurnId: nextTurnId });

  assert.deepEqual(turns.map((entry) => entry.ts), [5, 10, 20, 40, 50]);
  assert.deepEqual(turns.map((entry) => entry.channel), ['you', 'them', 'you', 'them', 'you']);
});

test('suppressed lookup accepts a stable id or a valid index and rejects unknown values', () => {
  const entries = [{ id: 'suppressed-1', text: 'one' }, { id: 'suppressed-2', text: 'two' }];
  assert.equal(findSuppressedYouIndex(entries, 'suppressed-2'), 1);
  assert.equal(findSuppressedYouIndex(entries, 0), 0);
  for (const unknown of ['suppressed-999', -1, 2, 1.5, null, undefined, {}, '']) {
    assert.equal(findSuppressedYouIndex(entries, unknown), -1, String(unknown));
  }
});

test('suppressed persistence is bounded and keeps restore metadata', () => {
  const entries = Array.from({ length: MAX_SUPPRESSED_YOU_SEGMENTS + 3 }, (_, index) => ({
    id: `suppressed-${index + 1}`,
    text: `Hidden line ${index + 1}`,
    ts: 1000 + index,
    duplicateOf: 42,
    match: 'similarity',
    reason: 'cross_talk',
  }));
  const normalized = normalizeSuppressedYouSegments(entries);
  assert.equal(normalized.length, MAX_SUPPRESSED_YOU_SEGMENTS);
  assert.equal(normalized[0].id, 'suppressed-4');
  assert.deepEqual(normalized.at(-1), {
    id: `suppressed-${MAX_SUPPRESSED_YOU_SEGMENTS + 3}`,
    text: `Hidden line ${MAX_SUPPRESSED_YOU_SEGMENTS + 3}`,
    ts: 1000 + MAX_SUPPRESSED_YOU_SEGMENTS + 2,
    duplicateOf: 42,
    match: 'similarity',
    reason: 'cross_talk',
  });
  assert.deepEqual(normalizeSuppressedYouSegments(undefined), []);
});

test('architecture documents the actual preload bridge size', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const docs = fs.readFileSync(path.join(root, 'docs', 'architecture.md'), 'utf8');
  let bridge;
  vm.runInNewContext(preload, {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } },
      ipcRenderer: {},
    }),
    process: { platform: 'linux', argv: [] },
  });
  const methods = Object.values(bridge).filter((value) => typeof value === 'function').length;
  const allowed = preload.match(/const allowed = \[([^\]]+)\]/)[1].split(',').filter((value) => value.trim()).length;
  assert.ok(docs.includes(`The bridge exposes ${Object.keys(bridge).length} members in total: ${methods} methods`));
  assert.ok(docs.includes(`filtered allowlist of ${allowed} IPC channels`));
  assert.ok(docs.includes('`transcriptRestoreSuppressed`'));
});

test('main and preload expose validated suppressed restore and checkpoint the change', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  assert.match(main, /handleTrusted\('transcript:restore-suppressed'/);
  assert.match(main, /function restoreSuppressedYou\([\s\S]*?findSuppressedYouIndex[\s\S]*?suppressedYouSegments\.splice/);
  assert.match(main, /restoreSuppressedYouSegment\(transcript, entry[\s\S]*?persistMeetingRecovery\(\{ immediate: true \}\)/);
  assert.match(preload, /transcriptRestoreSuppressed: \(id\) => ipcRenderer\.invoke\('transcript:restore-suppressed', id\)/);
});
