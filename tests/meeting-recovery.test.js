const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeetingRecovery, countUnsavedTurns } = require('../src/meeting-recovery');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('meeting recovery stores a bounded transcript atomically and loads it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  let now = 1000;
  const recovery = createMeetingRecovery({ file, now: () => now });

  const saved = recovery.save({
    enabled: true,
    startedAt: 500,
    turns: [{ id: 1, channel: 'you', text: '  Keep this text  ', ts: 600 }],
  });
  now += 1000;

  assert.deepEqual(saved, { saved: true, turnCount: 1, totalTurns: 1, truncated: 0, clippedTurns: 0 });
  assert.deepEqual(recovery.load({ enabled: true }), {
    version: 1,
    startedAt: 500,
    updatedAt: 1000,
    totalTurns: 1,
    truncated: 0,
    clippedTurns: 0,
    turns: [{ id: 1, channel: 'you', text: 'Keep this text', ts: 600 }],
  });
  recovery.clear();
  assert.equal(recovery.load({ enabled: true }), null);
});

test('a fresh recovery store can load the saved draft after a process restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  const firstProcess = createMeetingRecovery({ file, now: () => 1000 });
  firstProcess.save({
    enabled: true,
    startedAt: 500,
    turns: [{ id: 1, channel: 'them', text: 'The meeting is still recoverable.', ts: 600 }],
  });

  const restartedProcess = createMeetingRecovery({ file, now: () => 2000 });
  const draft = restartedProcess.load({ enabled: true });

  assert.equal(draft.turns[0].text, 'The meeting is still recoverable.');
  assert.equal(draft.startedAt, 500);
  assert.equal(draft.updatedAt, 1000);
});

test('meeting recovery does not retain data while disabled and removes corrupt drafts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  const recovery = createMeetingRecovery({ file });

  assert.deepEqual(recovery.save({ enabled: false, turns: [{ text: 'private' }] }), { saved: false, reason: 'disabled' });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '{invalid');
  assert.equal(recovery.load({ enabled: true }), null);
  assert.equal(fs.existsSync(file), false);
});

test('disabling history or removing the final turn clears the recovery draft', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  const recovery = createMeetingRecovery({ file });
  const turns = [{ id: 1, channel: 'them', text: 'Agenda item', ts: 600 }];

  recovery.save({ enabled: true, turns });
  assert.deepEqual(recovery.save({ enabled: true, turns: [] }), { saved: false, reason: 'empty' });
  assert.equal(fs.existsSync(file), false);

  recovery.save({ enabled: true, turns });
  assert.deepEqual(recovery.save({ enabled: false, turns }), { saved: false, reason: 'disabled' });
  assert.equal(fs.existsSync(file), false);
});

test('history clearing suppresses checkpoints until the session is reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  const recovery = createMeetingRecovery({ file });
  const turns = [{ id: 1, channel: 'them', text: 'Sensitive in-progress content', ts: 600 }];

  recovery.save({ enabled: true, turns });
  recovery.suppress();

  assert.deepEqual(recovery.save({ enabled: true, turns }), { saved: false, reason: 'suppressed' });
  assert.equal(fs.existsSync(file), false);

  recovery.resume();
  assert.deepEqual(recovery.save({ enabled: true, turns }), { saved: true, turnCount: 1, totalTurns: 1, truncated: 0, clippedTurns: 0 });
});

test('clearing recovery also removes an interrupted atomic-write temporary file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  const recovery = createMeetingRecovery({ file });
  fs.writeFileSync(`${file}.tmp`, 'private transcript');

  recovery.clear();

  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('meeting recovery restores a complete temporary checkpoint after an interrupted rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  const recovery = createMeetingRecovery({ file });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({
    version: 1,
    startedAt: 500,
    updatedAt: 1000,
    turns: [{ id: 1, channel: 'them', text: 'Recover this complete checkpoint.', ts: 600 }],
  }));

  const draft = recovery.load({ enabled: true });

  assert.equal(draft.turns[0].text, 'Recover this complete checkpoint.');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('meeting recovery prefers a complete temporary checkpoint when the clock moves backward', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  const recovery = createMeetingRecovery({ file });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    startedAt: 500,
    updatedAt: 2000,
    turns: [{ id: 1, channel: 'them', text: 'Older checkpoint.', ts: 600 }],
  }));
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({
    version: 1,
    startedAt: 500,
    updatedAt: 1000,
    turns: [{ id: 1, channel: 'them', text: 'Latest checkpoint.', ts: 600 }],
  }));

  const draft = recovery.load({ enabled: true });

  assert.equal(draft.turns[0].text, 'Latest checkpoint.');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt, 1000);
});

test('clearing history prevents the current transcript from recreating its recovery draft', () => {
  const main = read('main.js');
  const finalize = main.match(/function finalizeMeeting\(reason = 'capture-stop'[\s\S]*?\n\}/)?.[0] || '';
  const clearHistory = main.match(/handleTrusted\('history:clear',[\s\S]*?\n\}\);/)?.[0] || '';
  const resetTranscript = main.match(/function resetTranscriptData\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const startNewSession = main.match(/function startNewSession\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const clearTranscript = main.match(/handleTrusted\('transcript:clear',[\s\S]*?\n\}\);/)?.[0] || '';

  assert.match(clearHistory, /meetingRecovery\.suppress\(\)/);
  assert.match(finalize, /meetingRecovery\.isSuppressed\(\)/);
  assert.doesNotMatch(resetTranscript, /meetingRecovery\.resume\(\)/);
  assert.match(startNewSession, /meetingRecovery\.resume\(\)/);
  assert.match(clearTranscript, /resetTranscriptData\(\)/);
  assert.doesNotMatch(clearTranscript, /meetingRecovery\.resume\(\)/);
  assert.match(read('renderer/renderer.js'), /recoverySuppressed[\s\S]*start a new session to resume history/);
});

test('main process checkpoints only opted-in transcripts and exposes restore or discard', () => {
  const main = read('main.js');
  const preload = read('preload.js');
  const renderer = read('renderer/renderer.js');
  const html = read('renderer/index.html');

  assert.match(main, /createMeetingRecovery\(\{ file: path\.join\(currentUserDataPath, 'meeting-recovery\.json'\) \}\)/);
  assert.match(main, /meetingRecovery\.save\(\{[\s\S]*?enabled: historyEnabled/);
  assert.match(main, /handleTrusted\('recovery:get'/);
  assert.match(main, /handleTrusted\('recovery:restore'/);
  assert.match(main, /handleTrusted\('recovery:discard'/);
  assert.match(main, /function restoreMeetingRecovery\(\)[\s\S]*if \(state\.capturing \|\| transcript\.length\)/);
  assert.match(main, /turnId: id[\s\S]*segments: \[segment\]/);
  const restore = main.match(/function restoreMeetingRecovery\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(restore, /return \{ restored: true, turns: transcript\.map\(publicTranscriptTurn\)/);
  assert.doesNotMatch(restore, /meetingRecovery\.clear\(\)/);
  assert.match(preload, /recoveryGet: \(\) => ipcRenderer\.invoke\('recovery:get'\)/);
  assert.match(preload, /recoveryRestore: \(\) => ipcRenderer\.invoke\('recovery:restore'\)/);
  assert.match(preload, /recoveryDiscard: \(\) => ipcRenderer\.invoke\('recovery:discard'\)/);
  assert.match(renderer, /meeting-recovery-dialog/);
  assert.match(renderer, /recoveryRestore/);
  assert.match(renderer, /recoveryDiscard/);
  const recoveryLookup = renderer.match(/async function getRecoverySummary\(\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const boot = renderer.match(/\(async function boot\(\) \{[\s\S]*?\n  \}\)\(\);/)?.[0] || '';
  assert.match(recoveryLookup, /await volyxLens\.recoveryGet\(\)/);
  assert.match(recoveryLookup, /catch \(error\)/);
  assert.match(recoveryLookup, /showStatus\('Meeting recovery could not be checked/);
  assert.match(recoveryLookup, /return \{ unavailable: true \}/);
  assert.match(boot, /getRecoverySummary\(\)/);
  assert.match(boot, /recovery && !recovery\.unavailable/);
  assert.match(html, /id="meeting-recovery-dialog"/);
  assert.match(html, /in-progress transcript is checkpointed locally for recovery/);
});

test('meeting recovery reports how many turns the bounded draft dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  const recovery = createMeetingRecovery({ file, now: () => 5000 });
  const turns = Array.from({ length: 620 }, (_, index) => ({
    id: index + 1,
    channel: index % 2 ? 'you' : 'them',
    text: `Turn ${index + 1}`,
    ts: 1000 + index,
  }));

  const saved = recovery.save({ enabled: true, turns, startedAt: 500 });
  const draft = recovery.load({ enabled: true });

  assert.deepEqual(saved, { saved: true, turnCount: 500, totalTurns: 620, truncated: 120, clippedTurns: 0 });
  assert.equal(draft.turns.length, 500);
  assert.equal(draft.totalTurns, 620);
  assert.equal(draft.truncated, 120);
  assert.equal(draft.turns[0].text, 'Turn 121');
});

test('clearBestEffort keeps history operations alive when the draft cannot be removed', () => {
  const failingFs = {
    unlinkSync() {
      const error = new Error('operation not permitted');
      error.code = 'EACCES';
      throw error;
    },
  };
  const recovery = createMeetingRecovery({ file: '/tmp/never-written/recovery.json', fsImpl: failingFs });

  const result = recovery.clearBestEffort();

  assert.equal(result.cleared, false);
  assert.match(result.error, /operation not permitted/);
});

test('recovery draft cleanup never aborts finalize or history clearing', () => {
  const main = read('main.js');
  const finalize = main.match(/function finalizeMeeting\(reason = 'capture-stop'[\s\S]*?\n\}/)?.[0] || '';
  const clearHistory = main.match(/handleTrusted\('history:clear',[\s\S]*?\n\}\);/)?.[0] || '';
  const clearTranscript = main.match(/handleTrusted\('transcript:clear',[\s\S]*?\n\}\);/)?.[0] || '';
  const settingsSet = main.match(/handleTrusted\('settings:set',[\s\S]*?\n\}\);/)?.[0] || '';

  assert.doesNotMatch(finalize, /meetingRecovery\.clear\(\)/);
  assert.match(finalize, /meetingRecovery\.clearBestEffort\(\)/);
  assert.doesNotMatch(clearHistory, /recoverySuppressed: true/);
  assert.match(clearHistory, /try \{\s*meetingRecovery\.suppress\(\);/);
  assert.match(clearHistory, /recoverySuppressed = false/);
  assert.match(clearTranscript, /meetingRecovery\.clearBestEffort\(\)/);
  assert.match(settingsSet, /meetingRecovery\.clearBestEffort\(\)/);
});

test('resuming capture after a restore keeps the recovered meeting start time', () => {
  const main = read('main.js');
  const restore = main.match(/function restoreMeetingRecovery\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const applyCapture = main.match(/async function applyCaptureState\(active\) \{[\s\S]*?\n\}/)?.[0] || '';
  const clearTranscript = main.match(/handleTrusted\('transcript:clear',[\s\S]*?\n\}\);/)?.[0] || '';
  const newSession = main.match(/function startNewSession\(\) \{[\s\S]*?\n  \};/)?.[0] || '';

  assert.match(restore, /pendingRestoredStartedAt = Number\.isFinite\(recovery\.startedAt\)/);
  assert.match(applyCapture, /captureStartedAt = pendingRestoredStartedAt \|\| Date\.now\(\)/);
  assert.match(applyCapture, /pendingRestoredStartedAt = null/);
  assert.match(clearTranscript, /pendingRestoredStartedAt = null/);
  assert.match(newSession, /pendingRestoredStartedAt = null/);
});

test('the recovery dialog registers modal state and explains dropped turns', () => {
  const renderer = read('renderer/renderer.js');
  const dialogStart = renderer.indexOf("const meetingRecoveryDialog");
  const dialogEnd = renderer.indexOf('// ---- meeting history', dialogStart);
  const recoveryDialog = dialogStart >= 0 && dialogEnd > dialogStart ? renderer.slice(dialogStart, dialogEnd) : '';
  const boot = renderer.match(/\(async function boot\(\) \{[\s\S]*?\n  \}\)\(\);/)?.[0] || '';

  assert.equal((recoveryDialog.match(/meetingRecoveryDialog\.close\(\);/g) || []).length, 2);
  assert.equal((recoveryDialog.match(/volyxLens\.setModalState\(false\);/g) || []).length, 2);
  assert.match(boot, /volyxLens\.setModalState\(true\);\s*meetingRecoveryDialog\.showModal\(\);/);
  assert.match(boot, /recovery\.truncated/);
  assert.match(boot, /not saved because only the most recent turns are kept/);
});

test('a draft counts turns the live transcript already dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  const recovery = createMeetingRecovery({ file, now: () => 9000 });
  const turns = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    channel: 'them',
    text: `Kept turn ${index + 1}`,
    ts: 1000 + index,
  }));

  const saved = recovery.save({ enabled: true, turns, droppedTurns: 80, startedAt: 500 });
  const draft = recovery.load({ enabled: true });

  assert.deepEqual(saved, { saved: true, turnCount: 40, totalTurns: 120, truncated: 80, clippedTurns: 0 });
  assert.equal(draft.totalTurns, 120);
  assert.equal(draft.truncated, 80);
});

test('an over-long turn keeps its latest text and is reported as shortened', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-recovery-'));
  const file = path.join(dir, 'recovery.json');
  const recovery = createMeetingRecovery({ file });
  const longText = `HEAD-MARKER ${'start '.repeat(3000)}the decisive closing sentence`;

  const saved = recovery.save({
    enabled: true,
    turns: [{ id: 1, channel: 'you', text: longText, ts: 600 }, { id: 2, channel: 'them', text: 'short', ts: 700 }],
    startedAt: 500,
  });
  const draft = recovery.load({ enabled: true });

  assert.equal(saved.clippedTurns, 1);
  assert.equal(draft.clippedTurns, 1);
  assert.ok(draft.turns[0].text.length <= 12000, 'clipped turn should stay within the stored limit');
  assert.ok(draft.turns[0].text.length > 11900, 'clipped turn should keep a full window of recent text');
  assert.match(draft.turns[0].text, /the decisive closing sentence$/);
  assert.doesNotMatch(draft.turns[0].text, /HEAD-MARKER/);
});

test('an unanswered recovery draft survives quitting and starting a session', () => {
  const main = read('main.js');
  const finalize = main.match(/function finalizeMeeting\(reason = 'capture-stop'[\s\S]*?\n\}\n/)?.[0] || '';

  assert.match(finalize, /const pendingTurns = pendingFinalizeTurns\(\);/);
  assert.match(finalize, /if \(result\.saved \|\| pendingTurns\.length\) \{/);
  assert.match(finalize, /cancelMeetingRecoverySave\(\);\s*meetingRecovery\.clearBestEffort\(\);/);
});

test('checkpoints exclude turns that are already saved to history', () => {
  const main = read('main.js');
  const write = main.match(/function writeMeetingRecovery\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const record = main.match(/^function recordTranscript[\s\S]*?\n\}/m)?.[0] || '';

  assert.match(write, /turns: pendingFinalizeTurns\(\)/);
  assert.match(write, /droppedTurns: transcriptDroppedTurns/);
  assert.doesNotMatch(write, /turns: transcript\.map\(publicTranscriptTurn\)/);
  assert.match(record, /transcriptDroppedTurns \+= countUnsavedTurns\(removed, finalizedSegmentWatermark\);/);
  assert.match(record, /persistMeetingRecovery\(\);/);
});

test('checkpoint writes are coalesced and cancelled when the draft is cleared', () => {
  const main = read('main.js');
  const persist = main.match(/function persistMeetingRecovery\([\s\S]*?\n\}/)?.[0] || '';

  assert.match(persist, /setTimeout\(writeMeetingRecovery, MEETING_RECOVERY_SAVE_DELAY_MS\)/);
  assert.match(persist, /unref/);
  assert.match(persist, /if \(immediate\) \{[\s\S]*writeMeetingRecovery\(\);/);
  for (const handler of ["handleTrusted('transcript:clear'", "handleTrusted('history:clear'"]) {
    const block = main.match(new RegExp(`${handler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n\\}\\);`))?.[0] || '';
    assert.match(block, /cancelMeetingRecoverySave\(\)/, `${handler} should cancel a scheduled checkpoint`);
  }
});

test('trimmed turns that are already saved do not count as lost', () => {
  const saved = [
    { id: 1, segments: [{ id: 1 }, { id: 2 }] },
    { id: 2, segments: [{ id: 3 }] },
  ];
  const unsaved = [
    { id: 3, segments: [{ id: 4 }] },
    { id: 4, segments: [{ id: 3 }, { id: 5 }] },
  ];

  assert.equal(countUnsavedTurns(saved, 3), 0);
  assert.equal(countUnsavedTurns([...saved, ...unsaved], 3), 2);
  assert.equal(countUnsavedTurns(unsaved, 0), 2);
  assert.equal(countUnsavedTurns([], 5), 0);
  assert.equal(countUnsavedTurns(null, 5), 0);
});

test('the lost-turn counter resets once a save advances the boundary', () => {
  const main = read('main.js');
  const finalize = main.match(/function finalizeMeeting\(reason = 'capture-stop'[\s\S]*?\n\}\n/)?.[0] || '';

  assert.match(finalize, /advanceFinalizeWatermark\(\);/);
  assert.match(finalize, /transcriptDroppedTurns = 0;/);
});
