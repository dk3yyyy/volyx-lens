'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const icons = fs.readFileSync(path.join(root, 'renderer', 'icons.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src', 'meeting-store.js'), 'utf8');

test('history panel lives in the panel dock, off by default, behind a toggle', () => {
  assert.match(html, /id="meeting-history-panel" class="hidden"/);
  assert.match(html, /id="meeting-history-toggle"/);
  assert.match(html, /aria-controls="meeting-history-panel"/);
  assert.match(html, /id="meeting-history-toggle"[\s\S]*History/);
  assert.match(html, /id="meeting-history-list" role="list"/);
  assert.match(html, /id="meeting-history-search"[\s\S]*aria-label="Search saved meetings"/);
  assert.match(html, /id="meeting-history-clear"/);
  assert.match(html, /id="meeting-history-back"/);
  assert.match(html, /id="meeting-history-export-format"/);
  assert.match(html, /id="meeting-notes-generate"/);
  assert.match(html, /id="meeting-history-delete"/);
  assert.match(html, /id="meeting-notes-output"/);
});

test('history UI styles are present and compact', () => {
  assert.match(css, /#meeting-history-panel \{/);
  assert.match(css, /\.history-entry \{/);
  assert.match(css, /\.history-turn\.you \{/);
  assert.match(css, /\.history-notes \{/);
  assert.match(css, /#meeting-history-search \{/);
  assert.match(css, /\.history-empty \{/);
});

test('renderer opens the panel, lists, searches, and shows a privacy hint when empty', () => {
  assert.match(renderer, /function setMeetingHistoryOpen\(open\)/);
  assert.match(renderer, /\$\('#meeting-history-panel'\)\.classList\.toggle\('hidden', !open\)/);
  assert.match(renderer, /function loadMeetingHistory\(\{ quiet = false \} = \{\}\)/);
  assert.match(renderer, /volyxLens\.historyList\(\)/);
  assert.match(renderer, /meetingHistorySearch\.trim\(\)\.toLowerCase\(\)/);
  assert.match(renderer, /No meeting history yet\. Enable "Save meeting history"/);
  assert.match(renderer, /volyxLens\.historyDelete\(record\.id\)/);
  assert.match(renderer, /meeting-history-clear'\)\.disabled = records\.length === 0/);
});

test('renderer opens a detail view, exports, deletes, clears, and closes back to the list', () => {
  assert.match(renderer, /async function openMeetingDetail\(id\)/);
  assert.match(renderer, /volyxLens\.historyGet\(id\)/);
  assert.match(renderer, /renderMeetingTurns\(\)/);
  assert.match(renderer, /function closeMeetingDetail\(\)/);
  assert.match(renderer, /volyxLens\.historyExport\(meetingDetail\.id, \$\('#meeting-history-export-format'\)\.value\)/);
  assert.match(renderer, /volyxLens\.historyDelete\(meetingDetail\.id\)/);
  assert.match(renderer, /volyxLens\.historyClear\(\)/);
  assert.match(renderer, /meeting-history-list'\)\.classList\.add\('hidden'\)/);
  assert.match(renderer, /meeting-history-detail'\)\.classList\.remove\('hidden'\)/);
});

test('notes generation confirms long recaps and streams recap tokens into the panel', () => {
  assert.match(renderer, /volyxLens\.historyRecap\(meetingDetail\.id, confirmed\)/);
  assert.match(renderer, /requires_confirmation/);
  assert.match(renderer, /may incur a small provider charge\. Continue\?/);
  assert.match(renderer, /confirmed = true;\n\s*continue;/);
  assert.match(renderer, /volyxLens\.on\('history:recap-token'/);
  assert.match(renderer, /meetingNotesText \+= text/);
  assert.match(renderer, /volyxLens\.on\('history:changed'/);
  assert.match(renderer, /event\.deleted && meetingDetail && event\.id === meetingDetail\.id/);
});

test('history list surfaces a text preview for search without shipping full turns', () => {
  assert.match(store, /function previewText\(turns\)/);
  assert.match(store, /return text\.slice\(0, 120\)/);
  assert.match(store, /preview: previewText\(record\.turns\)/);
  assert.match(preload, /historyExport: \(id, format\) => ipcRenderer\.invoke\('history:export'/);
  assert.match(preload, /historyRecap: \(id, confirmed = false\)/);
  assert.match(preload, /'history:recap-token'/);
  assert.match(renderer, /record\.preview \|\| ''/);
});

test('history panel loads on boot so the dock badge is accurate', () => {
  assert.match(renderer, /loadMeetingHistory\(\{ quiet: true \}\)/);
  assert.match(renderer, /meeting-history-action-count'\)\.classList\.toggle\('hidden', meetingHistoryRecords\.length === 0\)/);
  assert.match(icons, /history: '<path d="M3 12a9 9 0 1 0 9-9/);
});