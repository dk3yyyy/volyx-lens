const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeetingRecovery } = require('../src/meeting-recovery');

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

  assert.deepEqual(saved, { saved: true, turnCount: 1 });
  assert.deepEqual(recovery.load({ enabled: true }), {
    version: 1,
    startedAt: 500,
    updatedAt: 1000,
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
  assert.deepEqual(recovery.save({ enabled: true, turns }), { saved: true, turnCount: 1 });
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
