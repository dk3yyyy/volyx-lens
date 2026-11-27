'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildMemoryContentFromNotes,
  hasMemoryContentFromNotes,
  createMeetingMemory,
  restoreMeetingMemory,
  searchMeetingMemories,
  hasMemorySearchTerms,
  buildMemorySearchQuery,
} = require('../src/inspectable-memory');

function meeting(id, content, updatedAt) {
  return {
    id,
    memory: {
      version: 1,
      enabled: true,
      content,
      source: { type: 'meeting-notes', meetingId: id },
      updatedAt,
    },
  };
}

test('memory records retain source meeting, transcript provenance, and timestamps', () => {
  const memory = createMeetingMemory({
    meetingId: 'meeting-1',
    endedAt: 1_799_000_000_000,
    notes: { summary: 'Ship behind a flag.', source: 'cleaned', sourceHash: 'A'.repeat(64) },
    now: 1_800_000_000_000,
  });

  assert.equal(memory.version, 1);
  assert.equal(memory.enabled, true);
  assert.equal(memory.source.type, 'meeting-notes');
  assert.equal(memory.source.meetingId, 'meeting-1');
  assert.equal(memory.source.endedAt, 1_799_000_000_000);
  assert.equal(memory.source.transcriptSource, 'cleaned');
  assert.equal(memory.source.transcriptHash, 'a'.repeat(64));
  assert.equal(memory.createdAt, 1_800_000_000_000);
  assert.equal(memory.updatedAt, 1_800_000_000_000);
});

test('processed transcript provenance survives memory creation and restore', () => {
  const memory = createMeetingMemory({
    meetingId: 'meeting-processed',
    endedAt: 100,
    notes: { summary: 'Corrected locally.', source: 'processed' },
    now: 200,
  });
  assert.equal(memory.source.transcriptSource, 'processed');
  assert.equal(restoreMeetingMemory(memory, { meetingId: 'meeting-processed', endedAt: 100, now: 300 }).source.transcriptSource, 'processed');
});

test('editing a memory preserves its creation date and enabled state', () => {
  const original = createMeetingMemory({
    meetingId: 'meeting-1',
    notes: { summary: 'Original.', source: 'raw' },
    now: 100,
  });
  original.enabled = false;
  const updated = createMeetingMemory({
    meetingId: 'meeting-1',
    endedAt: 200,
    notes: { summary: 'Corrected.', source: 'cleaned' },
    existing: original,
    now: 300,
  });

  assert.equal(updated.content, 'Summary: Corrected.');
  assert.equal(updated.enabled, false);
  assert.equal(updated.createdAt, 100);
  assert.equal(updated.updatedAt, 300);
  assert.equal(updated.source.endedAt, 200);
});

test('lexical retrieval honors per-entry disable and keeps conflicting sources separate', () => {
  const first = meeting('meeting-1', 'Launch is June 12.', 20);
  const second = meeting('meeting-2', 'Launch is June 19.', 10);
  first.memory.enabled = false;

  const matches = searchMeetingMemories([first, second], 'launch June');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].meetingId, 'meeting-2');
  assert.match(matches[0].memory.content, /June 19/);
  second.memory.enabled = false;
  assert.deepEqual(searchMeetingMemories([first, second], 'launch'), []);
});

test('distinct matching memories are returned separately rather than silently merged', () => {
  const matches = searchMeetingMemories([
    meeting('meeting-1', 'The release is scheduled for June 12.', 20),
    meeting('meeting-2', 'The release is scheduled for June 19.', 10),
  ], 'release scheduled');

  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((item) => item.meetingId), ['meeting-1', 'meeting-2']);
  assert.notEqual(matches[0].memory.content, matches[1].memory.content);
});

test('memory retrieval has a bounded result set', () => {
  const memories = Array.from({ length: 8 }, (_, index) => meeting(
    `meeting-${index}`,
    `The launch decision is record ${index}.`,
    index,
  ));

  assert.equal(searchMeetingMemories(memories, 'launch decision').length, 5);
  assert.equal(searchMeetingMemories(memories, 'launch decision', { limit: 100 }).length, 5);
});

test('restored memory fails closed when enabled is missing or not a boolean', () => {
  for (const enabled of [undefined, null, 0, 1, 'false', 'true']) {
    const memory = restoreMeetingMemory({
      version: 1,
      content: 'Private memory',
      enabled,
      source: {},
    }, { meetingId: 'meeting-1', endedAt: 1 });
    assert.equal(memory, null, String(enabled));
  }
  const disabled = restoreMeetingMemory({
    version: 1,
    content: 'Private memory',
    enabled: false,
    source: {},
  }, { meetingId: 'meeting-1', endedAt: 1 });
  assert.equal(disabled.enabled, false);
});

test('stopword-only memory queries are rejected before scanning the store', () => {
  assert.equal(hasMemorySearchTerms('the and is'), false);
  assert.equal(hasMemorySearchTerms('launch decision'), true);
});

test('common words and partial substrings cannot select unrelated memories', () => {
  const memories = [meeting('meeting-1', 'The private launch party starts after review.', 20)];
  for (const query of ['the', 'art', 'the art', 'is']) {
    assert.deepEqual(searchMeetingMemories(memories, query), [], query);
  }
});

test('retrieval requires whole-term evidence and more than one term when available', () => {
  const memories = [
    meeting('meeting-weak', 'Pricing was updated.', 30),
    meeting('meeting-strong', 'Acme pricing and launch date changed.', 20),
  ];
  const matches = searchMeetingMemories(memories, 'Acme pricing launch date');
  assert.deepEqual(matches.map((item) => item.meetingId), ['meeting-strong']);
});

test('retrieved excerpts include matching text near the end of a memory', () => {
  const content = `${'background '.repeat(200)}Secret tail decision: delay launch.`;
  const matches = searchMeetingMemories([meeting('meeting-tail', content, 20)], 'secret tail decision');
  assert.equal(matches.length, 1);
  assert.match(matches[0].excerpt, /Secret tail decision/);
  assert.ok(matches[0].excerpt.length <= 1000);
});

test('memory query construction preserves the question and newest transcript within its budget', () => {
  const query = buildMemorySearchQuery(
    'Acme pricing?',
    `${'old context '.repeat(1000)}newest launch decision`,
  );
  assert.match(query, /Acme pricing/);
  assert.match(query, /newest launch decision/);
  assert.ok(query.length <= 4000);
});

test('notes presence checks are non-throwing and do not apply the memory size limit', () => {
  assert.equal(hasMemoryContentFromNotes(null), false);
  assert.equal(hasMemoryContentFromNotes({ summary: ' ', decisions: ['  '] }), false);
  assert.equal(hasMemoryContentFromNotes({ summary: 'x'.repeat(5000) }), true);
  assert.equal(hasMemoryContentFromNotes({ actionItems: ['x'.repeat(5000)] }), true);
  const unreadable = Object.defineProperty({}, 'summary', { get() { throw new Error('unreadable'); } });
  assert.equal(hasMemoryContentFromNotes(unreadable), false);
  assert.throws(() => buildMemoryContentFromNotes({ summary: 'x'.repeat(5000) }), /4000 characters/i, 'saving memory still enforces the limit');
});

test('notes content preserves labeled sections and rejects empty, excessive, or unsafe input', () => {
  assert.equal(buildMemoryContentFromNotes({
    summary: 'Ship in two stages.',
    decisions: ['Keep rollout opt-in.'],
    actionItems: ['Confirm the owner.'],
  }), 'Summary: Ship in two stages.\nDecisions:\n- Keep rollout opt-in.\nAction items:\n- Confirm the owner.');
  assert.equal(buildMemoryContentFromNotes({ summary: '', decisions: [], actionItems: [] }), '');
  assert.throws(() => buildMemoryContentFromNotes({ summary: 'x'.repeat(5000) }), /4000 characters/i);
  assert.throws(() => createMeetingMemory({ meetingId: '../unsafe', notes: { summary: 'Invalid source.' } }), /meeting id/i);
  assert.throws(() => createMeetingMemory({ meetingId: 'meeting-1', notes: {} }), /do not contain/i);
});
