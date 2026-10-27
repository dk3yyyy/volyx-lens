const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer/renderer.js');
const html = read('renderer/index.html');
const css = read('renderer/styles.css');

test('the pane can name the other speaker', () => {
  assert.match(html, /id="meeting-participant"/);
  assert.match(html, /maxlength="80"/);
  assert.match(preload, /historyParticipant: \(id, participant\) => ipcRenderer\.invoke\('history:participant', \{ id, participant \}\)/);
  assert.match(main, /handleTrusted\('history:participant'/);
  assert.match(renderer, /\$\('#meeting-participant'\)\.addEventListener\('change'/);
  assert.match(renderer, /speakerLabelFor\(turn\.channel\)/);
});

test('cleanup can be inspected and thrown away', () => {
  assert.match(html, /id="meeting-discard-cleaned"/);
  assert.match(preload, /historyDiscardCleaned: \(id\) => ipcRenderer\.invoke\('history:discard-cleaned', id\)/);
  assert.match(main, /handleTrusted\('history:discard-cleaned'/);

  const start = renderer.indexOf('function changedMeetingTurns');
  assert.ok(start > 0, 'the pane computes what cleanup changed');
  const body = renderer.slice(start, start + 700);
  assert.match(body, /meetingDetail\.cleaned\.texts\[index\]/);
  assert.doesNotMatch(body, /innerHTML/);

  assert.match(renderer, /const VIEW_ORDER = \['cleaned', 'raw', 'changes'\]/);
  assert.match(renderer, /history-text-before/);
  assert.match(renderer, /history-text-after/);
  assert.match(css, /\.history-text-before \{ color: var\(--tx-mut\); text-decoration: line-through/);
});

test('the list and search cover what the pane displays', () => {
  const start = renderer.indexOf('function renderMeetingHistory');
  const body = renderer.slice(start, start + 2400);
  assert.match(body, /record\.previewCleaned/);
  assert.match(body, /record\.notesSummary/);
  assert.match(renderer, /record\.participant/);
  assert.match(renderer, /history-cleaned-badge/);
  assert.match(renderer, /Notes · cleaned/);
});

test('cleanup counts stay on the meeting after the run', () => {
  assert.match(renderer, /stats\.cleanedTurns/);
  assert.match(renderer, /kept as heard/);
  assert.match(main, /stats: \{/);
  assert.match(main, /cleanedTurns: accepted\.size/);
});

test('notes say which transcript they were generated from', () => {
  assert.match(renderer, /generated from the cleaned transcript/);
  assert.match(renderer, /Regenerate them to use the cleaned copy/);
  assert.match(css, /\.notes-source/);
});

test('history can be kept tidy without opening dialogs one by one', () => {
  assert.match(html, /id="meeting-history-select"/);
  assert.match(html, /id="meeting-history-delete-selected"/);
  assert.match(preload, /historyDeleteMany: \(ids\) => ipcRenderer\.invoke\('history:delete-many', ids\)/);
  assert.match(main, /handleTrusted\('history:delete-many'/);

  const start = renderer.indexOf("$('#meeting-history-delete-selected').addEventListener('click'");
  assert.ok(start > 0, 'the bulk delete button is wired');
  const body = renderer.slice(start, start + 700);
  assert.match(body, /historyDeleteMany/);
  assert.match(body, /You can undo this right after/);
});

test('the retention window is a setting, applied at startup and on change', () => {
  assert.match(html, /id="stt-retention-days"/);
  assert.match(renderer, /historyRetentionDays: Number\(\$\('#stt-retention-days'\)\.value\) \|\| 0/);
  assert.match(main, /function enforceHistoryRetention\(\)/);
  assert.match(main, /meetingStore\.pruneOlderThan\(days\)/);
  assert.match(main, /app\.whenReady\(\)\.then\(\(\) => \{/);
  assert.match(main, /enforceHistoryRetention\(\);/);
  assert.match(main, /previous\.transcription\.historyRetentionDays !== updated\.transcription\.historyRetentionDays/);
});

test('a retention of zero keeps everything', () => {
  const { getDefaultSettings } = require('../src/provider-config');
  assert.equal(getDefaultSettings().transcription.historyRetentionDays, 0);
});

test('a second launch focuses the first window instead of sharing the folder', () => {
  assert.match(main, /const primaryInstance = app\.requestSingleInstanceLock\(\);/);
  assert.match(main, /if \(!primaryInstance\) app\.quit\(\);/);
  assert.match(main, /app\.on\('second-instance', \(\) => \{/);
  assert.match(main, /if \(!primaryInstance\) return;/);
});

test('the meeting list can be driven from the keyboard', () => {
  assert.match(renderer, /\$\('#meeting-history-list'\)\.addEventListener\('keydown'/);
  assert.match(renderer, /event\.key === 'ArrowDown'/);
  assert.match(renderer, /event\.key === 'ArrowUp'/);
  assert.match(renderer, /event\.key === 'Home'/);
  assert.match(renderer, /event\.key === 'End'/);
  assert.match(renderer, /event\.key === 'Escape' && meetingSelectMode/);
  assert.match(renderer, /row\.setAttribute\('role', 'listitem'\)/);
  assert.match(renderer, /open\.setAttribute\('aria-label'/);
});

test('focus moves into the detail view and comes back to the meeting it came from', () => {
  assert.match(renderer, /let meetingDetailOpenerId = null;/);
  assert.match(renderer, /meetingDetailOpenerId = id;/);
  assert.match(renderer, /\$\('#meeting-history-back'\)\.focus\(\);/);
  assert.match(renderer, /document\.querySelector\(`#meeting-history-list \.history-entry\[data-meeting-id="\$\{openerId\}"\]/);
});
