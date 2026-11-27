const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert');
const { createMeetingStore, fingerprint } = require('../src/meeting-store');

test('fingerprint keeps the legacy digest and separates rawText encodings', () => {
  const legacyTurns = [{ id: 1, channel: 'you', text: 'hello | 2000', ts: 3000 }];
  // SHA-256 of the exact pre-rawText line: `1|you|hello | 2000|3000\n`.
  const legacyHash = fingerprint(legacyTurns).contentHash;
  assert.equal(legacyHash, '7c0f47fdc1a4715f7e59bd563078b292ecbfd368c6e2af2bc5ffde69dea87abd');

  // The old five-field encoding made these different transcripts identical.
  const rawTextTurns = [{ id: 1, channel: 'you', text: 'hello ', rawText: ' 2000', ts: 3000 }];
  assert.notEqual(fingerprint(rawTextTurns).contentHash, legacyHash);

  // Delimiters inside either wording must not alias two rawText transcripts.
  const rawTextA = [{ id: 1, channel: 'you', text: 'a|b', rawText: 'c', ts: 3000 }];
  const rawTextB = [{ id: 1, channel: 'you', text: 'a', rawText: 'b|c', ts: 3000 }];
  assert.notEqual(fingerprint(rawTextA).contentHash, fingerprint(rawTextB).contentHash);

  const withoutRawText = fingerprint([{ id: 2, channel: 'them', text: 'hello', ts: 4000 }]).contentHash;
  const withRawText = fingerprint([{ id: 2, channel: 'them', text: 'hello', rawText: 'hola', ts: 4000 }]).contentHash;
  assert.notEqual(withRawText, withoutRawText, 'the recognizer wording remains part of the digest');
});

test('diarization runs append as validated sidecars without changing transcript turns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const saved = store.finalize({ turns: [{ channel: 'them', text: 'Hello', ts: 1 }], enabled: true });
    assert.deepEqual(store.get(saved.id).diarizationRuns, []);
    const run = {
      version: 1,
      recordingId: 'diar-run-1',
      sourceChannel: 'them',
      status: 'ready',
      modelId: 'diar-sortformer-4spk',
      artifactSha256: 'a'.repeat(64),
      preset: 'very_high_latency',
      sampleRate: 16000,
      durationMs: 5000,
      segments: [
        { speakerId: 2, t0Ms: 2500, t1Ms: 4000 },
        { speakerId: 1, t0Ms: 100, t1Ms: 2000 },
      ],
    };
    assert.equal(store.updateDiarization(saved.id, run).updated, true);
    const record = store.get(saved.id);
    assert.equal(record.turns[0].channel, 'them');
    assert.equal(record.diarizationRuns.length, 1);
    assert.equal(record.diarizationRuns[0].segments[0].speakerId, 1, 'segments are chronological for display');
    assert.equal(store.updateDiarization(saved.id, { ...run, recordingId: 'bad', sourceChannel: 'you' }).updated, false);
    assert.equal(store.get(saved.id).diarizationRuns.length, 1);
    const imported = store.importRecords([record]);
    assert.equal(imported.imported, 1);
    assert.equal(store.get(imported.ids[0]).diarizationRuns.length, 1, 'backup restore preserves the sidecar');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diarization sidecars reject audio, out-of-range slots, and duplicate recordings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const saved = store.finalize({ turns: [{ channel: 'them', text: 'Hello', ts: 1 }], enabled: true });
    const run = {
      version: 1,
      recordingId: 'diar-run-1',
      sourceChannel: 'them',
      status: 'ready',
      modelId: 'diar-sortformer-4spk',
      artifactSha256: 'a'.repeat(64),
      preset: 'high_latency',
      sampleRate: 16000,
      durationMs: 5000,
      segments: [{ speakerId: 1, t0Ms: 100, t1Ms: 2000 }],
      audio: Buffer.from('not persisted').toString('base64'),
    };
    assert.equal(store.updateDiarization(saved.id, { ...run, segments: [{ speakerId: 5, t0Ms: 0, t1Ms: 1 }] }).updated, false);
    assert.equal(store.updateDiarization(saved.id, { ...run, segments: [{ speakerId: 1, t0Ms: 0, t1Ms: 6000 }] }).updated, false);
    assert.equal(store.updateDiarization(saved.id, run).updated, true);
    const stored = store.get(saved.id).diarizationRuns[0];
    assert.equal('audio' in stored, false, 'the sidecar carries timestamps only');
    assert.equal(stored.segments.length, 1);
    // A retried analysis of the same recording replaces its earlier attempt.
    assert.equal(store.updateDiarization(saved.id, { ...run, segments: [{ speakerId: 3, t0Ms: 10, t1Ms: 20 }] }).updated, true);
    const runs = store.get(saved.id).diarizationRuns;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].segments[0].speakerId, 1, 'a lone native slot 3 is the first voice heard, so it becomes 1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diarization runs validate a recording start offset and keep legacy sidecars at zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const saved = store.finalize({ turns: [{ channel: 'them', text: 'Hello', ts: 1 }], enabled: true });
    const base = {
      version: 1,
      recordingId: 'diar-offset-1',
      sourceChannel: 'them',
      status: 'ready',
      modelId: 'diar-sortformer-4spk',
      artifactSha256: 'a'.repeat(64),
      preset: 'high_latency',
      sampleRate: 16000,
      durationMs: 5000,
      segments: [{ speakerId: 1, t0Ms: 100, t1Ms: 2000 }],
    };

    // An explicit zero is valid and means the run began with the meeting.
    assert.equal(store.updateDiarization(saved.id, { ...base, audioStartOffsetMs: 0 }).updated, true);
    assert.equal(store.get(saved.id).diarizationRuns[0].audioStartOffsetMs, 0);

    // A later recorder keeps its offset while its segments stay recording-relative.
    assert.equal(store.updateDiarization(saved.id, { ...base, recordingId: 'diar-offset-2', audioStartOffsetMs: 240000 }).updated, true);
    const offsetRun = store.get(saved.id).diarizationRuns.find((run) => run.recordingId === 'diar-offset-2');
    assert.equal(offsetRun.audioStartOffsetMs, 240000);
    assert.deepEqual(offsetRun.segments, [{ speakerId: 1, t0Ms: 100, t1Ms: 2000 }], 'the offset never rewrites segment times');

    // Negative, fractional, non-numeric, and out-of-span offsets are rejected.
    for (const [label, audioStartOffsetMs] of [
      ['negative', -1],
      ['fractional', 1.5],
      ['string', '1000'],
      ['null', null],
      ['beyond safe integer', Number.MAX_SAFE_INTEGER + 1],
      ['offset plus audio beyond 30 days', 30 * 24 * 60 * 60 * 1000 - 5000 + 1],
    ]) {
      assert.equal(
        store.updateDiarization(saved.id, { ...base, recordingId: `diar-bad-${label}`, audioStartOffsetMs }).updated,
        false,
        label,
      );
    }
    // The inclusive bound is still a sane meeting.
    assert.equal(
      store.updateDiarization(saved.id, { ...base, recordingId: 'diar-bound', audioStartOffsetMs: 30 * 24 * 60 * 60 * 1000 - 5000 }).updated,
      true,
    );

    // A sidecar written before this field existed loads as offset zero.
    const legacyId = crypto.randomUUID();
    const legacyRecord = {
      id: legacyId,
      version: 1,
      reason: 'capture-stop',
      meeting: false,
      startedAt: 1000,
      endedAt: 2000,
      turnCount: 1,
      turns: [{ channel: 'them', text: 'Hello', ts: 1000 }],
      diarizationRuns: [{ ...base, recordingId: 'diar-legacy' }],
    };
    fs.writeFileSync(path.join(dir, `${legacyId}.json`), JSON.stringify(legacyRecord));
    const legacy = store.get(legacyId).diarizationRuns[0];
    assert.equal(legacy.audioStartOffsetMs, 0, 'existing sidecars default to zero instead of being dropped');
    assert.deepEqual(legacy.segments, [{ speakerId: 1, t0Ms: 100, t1Ms: 2000 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('meeting history preserves original recognizer wording when processing changed text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const saved = store.finalize({
      turns: [{ channel: 'you', text: 'Volyx Lens', rawText: 'volyx lens', ts: 1000 }],
      enabled: true,
    });
    const record = store.get(saved.id);
    assert.equal(record.turns[0].text, 'Volyx Lens');
    assert.equal(record.turns[0].rawText, 'volyx lens');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saved meetings retain bounded suppressed lines while exports omit them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const suppressedYouSegments = Array.from({ length: 205 }, (_, index) => ({
      id: `suppressed-${index + 1}`,
      text: `HIDDEN-ECHO-${index + 1}`,
      ts: 500 + index,
      duplicateOf: 1,
      match: 'similarity',
      reason: 'cross_talk',
    }));
    const saved = store.finalize({
      turns: [{ id: 1, channel: 'them', text: 'Visible meeting turn', ts: 100 }],
      suppressedYouSegments,
      enabled: true,
    });
    const record = store.get(saved.id);
    assert.equal(record.suppressedYouSegments.length, 200);
    assert.equal(record.suppressedYouSegments[0].text, 'HIDDEN-ECHO-6');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${saved.id}.json`), 'utf8'));
    assert.equal(onDisk.suppressedYouSegments.length, 200);

    const { formatMeetingRecord } = require('../src/meeting-notes');
    for (const format of ['txt', 'md', 'json', 'srt', 'vtt']) {
      assert.doesNotMatch(formatMeetingRecord(record, format), /HIDDEN-ECHO-/, `${format} export excludes hidden lines`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('older saved meeting records without suppressed lines still load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      id,
      version: 1,
      turns: [{ id: 1, channel: 'them', text: 'Legacy meeting', ts: 100 }],
    }));
    const record = store.get(id);
    assert.equal(record.turns[0].text, 'Legacy meeting');
    assert.deepEqual(record.suppressedYouSegments, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appending a restored turn updates saved order and removes its suppressed copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const hidden = { id: 'suppressed-1', text: 'My real answer', ts: 150, duplicateOf: 1, match: 'similarity', reason: 'cross_talk' };
    const first = store.finalize({
      turns: [{ id: 1, channel: 'them', text: 'Question', ts: 100 }, { id: 2, channel: 'them', text: 'Follow-up', ts: 300 }],
      suppressedYouSegments: [hidden],
      enabled: true,
    });
    const second = store.finalize({
      turns: [{ id: 3, channel: 'you', text: 'My real answer', ts: 150 }],
      suppressedYouSegments: [],
      recordId: first.id,
      enabled: true,
    });
    assert.equal(second.saved, true);
    const record = store.get(first.id);
    assert.deepEqual(record.turns.map((turn) => turn.text), ['Question', 'My real answer', 'Follow-up']);
    assert.deepEqual(record.suppressedYouSegments, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('suppressed-only changes update an existing saved meeting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const first = store.finalize({
      turns: [{ id: 1, channel: 'them', text: 'Visible turn', ts: 100 }],
      suppressedYouSegments: [{ id: 'suppressed-1', text: 'Old hidden line', ts: 150, duplicateOf: 1, match: 'similarity', reason: 'cross_talk' }],
      enabled: true,
    });
    const second = store.finalize({
      turns: [],
      suppressedYouSegments: [{ id: 'suppressed-2', text: 'New hidden line', ts: 200, duplicateOf: 1, match: 'similarity', reason: 'cross_talk' }],
      recordId: first.id,
      enabled: true,
    });
    assert.equal(second.saved, true);
    assert.deepEqual(store.get(first.id).suppressedYouSegments.map((entry) => entry.text), ['New hidden line']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test('meeting memory is editable, source-grounded, searchable, and cascades with source deletion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-memory-'));
  const store = createMeetingStore({ dir, now: () => 1_800_000_000_000 });
  const saved = store.finalize({
    turns: [{ channel: 'you', text: 'Keep the rollout opt-in.', ts: 1000 }],
    enabled: true,
    endedAt: 1_799_000_000_000,
  });
  store.updateNotes(saved.id, {
    summary: 'Keep the rollout opt-in.',
    decisions: ['Ship only after review.'],
    source: 'cleaned',
    sourceHash: 'a'.repeat(64),
  });

  const memory = store.saveMemoryFromNotes(saved.id);
  assert.equal(memory.saved, true);
  assert.equal(memory.memory.source.meetingId, saved.id);
  assert.equal(memory.memory.source.transcriptHash, 'a'.repeat(64));
  assert.equal(store.listMemories().length, 1);
  assert.equal(store.searchMemories('rollout opt-in')[0].meetingId, saved.id);
  assert.equal(store.updateMemory(saved.id, 'Corrected: release only after approval.').updated, true);
  assert.equal(store.searchMemories('approval')[0].memory.content, 'Corrected: release only after approval.');
  assert.equal(store.setMemoryEnabled(saved.id, false).updated, true);
  assert.deepEqual(store.searchMemories('approval'), []);

  const removed = store.remove(saved.id);
  assert.equal(removed.removed, true);
  assert.equal(removed.memoryRemoved, true);
  assert.equal(store.listMemories().length, 0);
  const trashPath = path.join(`${dir}-trash`, fs.readdirSync(`${dir}-trash`)[0]);
  assert.equal(JSON.parse(fs.readFileSync(trashPath, 'utf8')).memory, null);
});

test('deleting one memory leaves its saved transcript and generated notes intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-memory-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({
    turns: [{ channel: 'you', text: 'Keep the current plan.', ts: 1000 }],
    enabled: true,
  });
  const notes = { summary: 'Keep the current plan.', decisions: ['Review next week.'] };
  store.updateNotes(saved.id, notes);
  store.saveMemoryFromNotes(saved.id);

  assert.equal(store.removeMemory(saved.id).removed, true);
  const after = store.get(saved.id);
  assert.equal(after.memory, null);
  assert.equal(after.turns[0].text, 'Keep the current plan.');
  assert.deepEqual(after.notes, notes);
});

test('source deletion fails closed when the meeting record cannot be read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-memory-'));
  let failRead = false;
  let target;
  const fsImpl = {
    ...fs,
    readFileSync: (file, ...args) => {
      if (failRead && file === target) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return fs.readFileSync(file, ...args);
    },
  };
  const store = createMeetingStore({ dir, fsImpl });
  const saved = store.finalize({ turns: [{ channel: 'you', text: 'Private meeting', ts: 1 }], enabled: true });
  store.updateNotes(saved.id, { summary: 'Private memory' });
  store.saveMemoryFromNotes(saved.id);
  target = path.join(dir, `${saved.id}.json`);

  failRead = true;
  const result = store.remove(saved.id);
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'read_failed');
  assert.equal(fs.existsSync(target), true);
  assert.deepEqual(fs.existsSync(`${dir}-trash`) ? fs.readdirSync(`${dir}-trash`) : [], []);
});

test('failed source deletion keeps the live memory and removes the sanitized trash copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-memory-'));
  let failUnlink = false;
  let target;
  const fsImpl = {
    ...fs,
    unlinkSync: (file) => {
      if (failUnlink && file === target) {
        failUnlink = false;
        throw new Error('delete failed');
      }
      return fs.unlinkSync(file);
    },
  };
  const store = createMeetingStore({ dir, fsImpl });
  const saved = store.finalize({ turns: [{ channel: 'you', text: 'Private meeting', ts: 1 }], enabled: true });
  store.updateNotes(saved.id, { summary: 'Private memory' });
  store.saveMemoryFromNotes(saved.id);
  target = path.join(dir, `${saved.id}.json`);

  failUnlink = true;
  const result = store.remove(saved.id);
  assert.equal(result.removed, false);
  assert.ok(store.get(saved.id).memory, 'the live memory is still present');
  assert.deepEqual(fs.readdirSync(`${dir}-trash`), [], 'no stale sanitized copy is left behind');
});

test('memory deletion and retention remove stale temp copies of the source record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-memory-'));
  const now = 1_800_000_000_000;
  const store = createMeetingStore({ dir, now: () => now });
  const saved = store.finalize({
    turns: [{ channel: 'you', text: 'Private meeting', ts: 1 }],
    enabled: true,
    endedAt: now - 20 * 24 * 60 * 60 * 1000,
  });
  store.updateNotes(saved.id, { summary: 'Private memory' });
  store.saveMemoryFromNotes(saved.id);
  const stale = path.join(dir, `${saved.id}.json.crashed.tmp`);
  const old = (now - 10 * 60 * 1000) / 1000;
  fs.writeFileSync(stale, '{"memory":"PRIVATE STALE MEMORY"}');
  fs.utimesSync(stale, old, old);

  assert.equal(store.removeMemory(saved.id).removed, true);
  assert.equal(fs.existsSync(stale), false);

  store.saveMemoryFromNotes(saved.id);
  fs.writeFileSync(stale, '{"memory":"PRIVATE STALE MEMORY"}');
  fs.utimesSync(stale, old, old);
  assert.equal(store.pruneOlderThan(7, { now }).removed, 1);
  assert.equal(fs.existsSync(stale), false);
});

test('stopword-only memory queries do not read meeting files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-memory-'));
  let reads = 0;
  const fsImpl = {
    ...fs,
    readFileSync: (file, ...args) => {
      if (String(file).endsWith('.json')) reads += 1;
      return fs.readFileSync(file, ...args);
    },
  };
  const store = createMeetingStore({ dir, fsImpl });
  const saved = store.finalize({ turns: [{ channel: 'you', text: 'Meeting', ts: 1 }], enabled: true });
  store.updateNotes(saved.id, { summary: 'Meeting' });
  store.saveMemoryFromNotes(saved.id);
  reads = 0;
  assert.deepEqual(store.searchMemories('the and is'), []);
  assert.equal(reads, 0);
});

test('memory listing reuses parsed entries until a source meeting changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-memory-'));
  let reads = 0;
  const fsImpl = {
    ...fs,
    readFileSync: (file, ...args) => {
      if (String(file).endsWith('.json')) reads += 1;
      return fs.readFileSync(file, ...args);
    },
  };
  const store = createMeetingStore({ dir, fsImpl });
  const saved = store.finalize({ turns: [{ channel: 'you', text: 'Cached memory', ts: 1 }], enabled: true });
  store.updateNotes(saved.id, { summary: 'Cached memory' });
  store.saveMemoryFromNotes(saved.id);
  reads = 0;

  assert.equal(store.listMemories().length, 1);
  const firstReads = reads;
  assert.equal(store.listMemories().length, 1);
  assert.equal(reads, firstReads);

  store.updateMemory(saved.id, 'Changed memory');
  assert.equal(store.listMemories()[0].memory.content, 'Changed memory');
  assert.ok(reads > firstReads);
});

test('opening a meeting store sweeps stale temp copies left by a crashed writer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-memory-'));
  createMeetingStore({ dir });
  const stale = path.join(dir, 'crashed.json.tmp');
  fs.writeFileSync(stale, '{"memory":"PRIVATE STALE MEMORY"}');
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);

  createMeetingStore({ dir });
  assert.equal(fs.existsSync(stale), false);
});

test('meeting memory follows meeting retention and survives a backup restore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-memory-'));
  let now = 1_800_000_000_000;
  const store = createMeetingStore({ dir, now: () => now });
  const saved = store.finalize({
    turns: [{ channel: 'you', text: 'Keep the rollout opt-in.', ts: 1000 }],
    enabled: true,
    endedAt: now - 20 * 24 * 60 * 60 * 1000,
  });
  store.updateNotes(saved.id, { summary: 'Keep the rollout opt-in.', source: 'raw' });
  store.saveMemoryFromNotes(saved.id);
  const backupRecord = store.get(saved.id);
  const restore = store.importRecords([backupRecord]);
  assert.equal(restore.imported, 1);
  assert.equal(store.listMemories().length, 2);

  now += 1;
  const pruned = store.pruneOlderThan(7, { now });
  assert.equal(pruned.removed, 2);
  assert.equal(store.listMemories().length, 0);
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

test('notes containing only decisions or follow-up still count as notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({ turns: [{ channel: 'you', text: 'Hello', ts: 1000 }], enabled: true });
  store.updateNotes(saved.id, { summary: '', keyPoints: [], decisions: ['Approve the budget'], actionItems: [], followUp: [] });
  assert.equal(store.list()[0].hasNotes, true);
  store.updateNotes(saved.id, { summary: '', keyPoints: [], decisions: [], actionItems: [], followUp: ['Send the deck'] });
  assert.equal(store.list()[0].hasNotes, true);
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
  assert.equal(writes.length, 1);
  assert.match(writes[0], /\.json\.[\w-]+\.tmp$/, 'the write goes to its own temp file');
  assert.notEqual(writes[0], target, 'the live record is never written in place');
  const rename = calls.find((call) => call[0] === 'rename');
  assert.deepEqual(rename, ['rename', writes[0], target]);
  assert.equal(fs.existsSync(writes[0]), false, 'the temp file does not survive');
  // Filesystems round sub-millisecond timestamps, so near-equality is the real
  // property: the record stays where it was instead of jumping to the top.
  const mtimeAfter = fs.statSync(target).mtimeMs;
  assert.ok(Math.abs(mtimeAfter - mtimeBefore) <= 2, `a derived write does not reorder history (drift ${mtimeAfter - mtimeBefore}ms)`);
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
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'the temp copy is removed');
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


test('prune sweeps a stale temp copy but leaves another instance write alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  for (let index = 0; index < 201; index += 1) {
    store.finalize({ turns: [{ channel: 'you', text: `turn ${index}`, ts: index }], enabled: true, reason: 'capture-stop' });
  }
  const stale = path.join(dir, 'crashed.json.tmp');
  const fresh = path.join(dir, 'inflight.json.tmp');
  fs.writeFileSync(stale, '{}');
  fs.writeFileSync(fresh, '{}');
  const longAgo = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(stale, longAgo, longAgo);

  store.finalize({ turns: [{ channel: 'you', text: 'last session', ts: 9999 }], enabled: true });

  assert.equal(fs.existsSync(stale), false, 'a temp copy from a dead writer is cleaned up');
  assert.equal(fs.existsSync(fresh), true, 'an in-flight write by another instance is left alone');
  store.clear();
});

test('prune never deletes a valid meeting to make room for corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  for (let index = 0; index < 199; index += 1) {
    store.finalize({ turns: [{ channel: 'you', text: `turn ${index}`, ts: index }], enabled: true, reason: 'capture-stop' });
  }
  fs.writeFileSync(path.join(dir, 'corrupt-a.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'corrupt-b.json'), '{"version":1}');
  const saved = store.finalize({ turns: [{ channel: 'you', text: 'last session', ts: 9999 }], enabled: true });
  assert.equal(saved.pruned, 0);
  assert.equal(store.list().length, 200);
  assert.equal(fs.existsSync(path.join(dir, 'corrupt-a.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'corrupt-b.json')), true);
  store.clear();
});

test('a meeting can name the other speaker, and the name survives a re-read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({ turns: [{ channel: 'them', text: 'Hello there', ts: 1000 }], enabled: true });
  assert.equal(store.get(saved.id).participant, null);
  assert.equal(store.updateParticipant(saved.id, '  Ada Lovelace  ').updated, true);
  assert.equal(store.get(saved.id).participant, 'Ada Lovelace');
  assert.equal(store.updateParticipant(saved.id, '').updated, true);
  assert.equal(store.get(saved.id).participant, null, 'an empty name clears it');
  store.clear();
});

test('a participant name is bounded and cannot be anything but text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({ turns: [{ channel: 'them', text: 'Hello there', ts: 1000 }], enabled: true });
  assert.equal(store.updateParticipant(saved.id, 'x'.repeat(200)).updated, true);
  assert.equal(store.get(saved.id).participant.length, 80);
  assert.equal(store.updateParticipant('../etc/passwd', 'Ada').updated, false);
  assert.equal(store.updateParticipant('missing-record', 'Ada').updated, false);
  store.clear();
});

test('discarding a cleaned copy keeps the raw transcript and the notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({ turns: [{ channel: 'you', text: 'hello world', ts: 1000 }], enabled: true });
  store.updateCleaned(saved.id, { texts: ['Hello, world.'], model: 'm', provider: 'p' });
  store.updateNotes(saved.id, { summary: 'S', keyPoints: [], decisions: [], actionItems: [], followUp: [] });
  assert.equal(store.list()[0].hasCleaned, true);

  assert.equal(store.clearCleaned(saved.id).updated, true);
  const record = store.get(saved.id);
  assert.equal(record.cleaned, null);
  assert.equal(record.turns[0].text, 'hello world', 'the raw wording is untouched');
  assert.equal(record.notes.summary, 'S');
  assert.equal(store.list()[0].hasCleaned, false);
  store.clear();
});

test('the list carries what the pane searches and badges', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  const saved = store.finalize({ turns: [{ channel: 'them', text: 'the raw wording mentions pineapple', ts: 1000 }], enabled: true });
  store.updateParticipant(saved.id, 'Ada');
  store.updateCleaned(saved.id, { texts: ['The cleaned wording mentions mango.'] });
  store.updateNotes(saved.id, { summary: 'Talked about oranges', keyPoints: [], decisions: [], actionItems: [], followUp: [], source: 'cleaned' });

  const row = store.list()[0];
  assert.equal(row.participant, 'Ada');
  assert.equal(row.previewCleaned, 'The cleaned wording mentions mango.');
  assert.equal(row.notesSummary, 'Talked about oranges');
  assert.equal(row.notesSource, 'cleaned');
  assert.match(row.preview, /pineapple/, 'the raw preview is still available');
  store.clear();
});

test('retention deletes only records older than the cutoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  let clock = 1_000_000_000_000;
  const store = createMeetingStore({ dir, now: () => clock });
  const old = store.finalize({ turns: [{ channel: 'you', text: 'older session', ts: 1 }], enabled: true, endedAt: clock });
  clock += 40 * 24 * 60 * 60 * 1000;
  const recent = store.finalize({ turns: [{ channel: 'you', text: 'newer session', ts: 2 }], enabled: true, endedAt: clock });

  const result = store.pruneOlderThan(30);
  assert.equal(result.removed, 1);
  assert.equal(store.get(old.id), null, 'the record past the window is gone');
  assert.ok(store.get(recent.id), 'the record inside the window survives');
  store.clear();
});

test('retention zero or a nonsense value keeps everything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  store.finalize({ turns: [{ channel: 'you', text: 'a session', ts: 1 }], enabled: true, endedAt: 1 });
  assert.equal(store.pruneOlderThan(0).removed, 0);
  assert.equal(store.pruneOlderThan(-5).removed, 0);
  assert.equal(store.pruneOlderThan('abc').removed, 0);
  assert.equal(store.list().length, 1);
  store.clear();
});

test('legacy native speaker slots are renumbered to arrival order on read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const saved = store.finalize({ turns: [{ channel: 'them', text: 'Hi', ts: 1 }], enabled: true });
    const run = {
      version: 1,
      recordingId: 'diar-legacy-order',
      sourceChannel: 'them',
      status: 'ready',
      modelId: 'diar-sortformer-4spk',
      artifactSha256: 'b'.repeat(64),
      preset: 'very_high_latency',
      sampleRate: 16000,
      durationMs: 6000,
      segments: [
        { speakerId: 3, t0Ms: 100, t1Ms: 1500 },
        { speakerId: 1, t0Ms: 1600, t1Ms: 3000 },
        { speakerId: 2, t0Ms: 3100, t1Ms: 4500 },
        { speakerId: 3, t0Ms: 4600, t1Ms: 5900 },
      ],
    };
    assert.equal(store.updateDiarization(saved.id, run).updated, true);
    const segments = store.get(saved.id).diarizationRuns[0].segments;
    assert.deepEqual(segments.map((segment) => segment.speakerId), [1, 2, 3, 1],
      'first distinct voice becomes 1, the next new one 2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshing a split turn replaces saved surrounding speech instead of duplicating it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const saved = store.finalize({
      turns: [{ id: 1, channel: 'them', text: 'Before the answer. After the answer.', ts: 10 }],
      enabled: true,
    });
    store.finalize({
      recordId: saved.id,
      replaceAllTurns: true,
      turns: [
        { id: 1, channel: 'them', text: 'Before the answer.', ts: 10 },
        { id: 2, channel: 'you', text: 'My answer.', ts: 20 },
        { id: 3, channel: 'them', text: 'After the answer.', ts: 30 },
      ],
      enabled: true,
    });

    const record = store.get(saved.id);
    assert.deepEqual(record.turns.map((turn) => [turn.ts, turn.channel, turn.text]), [
      [10, 'them', 'Before the answer.'],
      [20, 'you', 'My answer.'],
      [30, 'them', 'After the answer.'],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a full history rewrite keeps new-session turns even when ids repeat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const saved = store.finalize({ turns: [{ id: 1, channel: 'them', text: 'Earlier session', ts: 1000 }], enabled: true });
    store.finalize({
      recordId: saved.id,
      replaceAllTurns: true,
      turns: [
        { id: 1, channel: 'them', text: 'Earlier session', ts: 1000 },
        { id: 1, channel: 'you', text: 'Unsaved restored answer', ts: 2000 },
      ],
      enabled: true,
    });
    assert.deepEqual(store.get(saved.id).turns.map((entry) => entry.text), ['Earlier session', 'Unsaved restored answer']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a restore after resuming rewrites extended speech without repeating its saved prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-store-'));
  const store = createMeetingStore({ dir });
  try {
    const saved = store.finalize({
      turns: [{ id: 1, channel: 'you', text: 'First answer.', ts: 20 }],
      enabled: true,
    });
    store.finalize({
      recordId: saved.id,
      replaceAllTurns: true,
      turns: [{ id: 1, channel: 'you', text: 'First answer. New words. Restored line.', ts: 20 }],
      enabled: true,
    });
    const record = store.get(saved.id);
    assert.equal(record.turns.length, 1);
    assert.equal(record.turns[0].text, 'First answer. New words. Restored line.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
