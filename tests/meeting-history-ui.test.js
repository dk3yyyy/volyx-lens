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
  assert.match(renderer, /meeting-history-clear'\)\.disabled = meetingHistoryRecords\.length === 0/);
});

test('renderer opens a detail view, exports, deletes, clears, and closes back to the list', () => {
  assert.match(renderer, /async function openMeetingDetail\(id\)/);
  assert.match(renderer, /volyxLens\.historyGet\(id\)/);
  assert.match(renderer, /renderMeetingTurns\(\)/);
  assert.match(renderer, /function closeMeetingDetail\(\)/);
  assert.match(renderer, /volyxLens\.historyExport\(meetingDetail\.id, \$\('#meeting-history-export-format'\)\.value, exportSource\)/);
  assert.match(renderer, /volyxLens\.historyDelete\(meetingDetail\.id\)/);
  assert.match(renderer, /volyxLens\.historyClear\(\)/);
  assert.match(renderer, /meeting-history-list'\)\.classList\.add\('hidden'\)/);
  assert.match(renderer, /meeting-history-detail'\)\.classList\.remove\('hidden'\)/);
});

test('renderer confirms every destructive history action before deleting', () => {
  assert.match(renderer, /if \(!window\.confirm\('Delete this saved meeting\? Any saved memory linked to it will also be deleted and will not return on Undo\.'\)\) return;/);
  assert.match(renderer, /if \(!window\.confirm\('Delete ALL saved meetings and their linked memories\? This cannot be undone, and it permanently removes the undo copies of earlier deletes\.'\)\) return;/);
  const rowDelete = renderer.match(/history-entry-delete[\s\S]*?historyDelete\(record\.id\)/);
  assert.ok(rowDelete, 'list-row delete handler exists');
  assert.match(rowDelete[0], /window\.confirm\('Delete this saved meeting\? Any saved memory linked to it will also be deleted and will not return on Undo\.'\)/);
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
  assert.match(preload, /historyExport: \(id, format, source = 'auto'\) => ipcRenderer\.invoke\('history:export'/);
  assert.match(preload, /historyRecap: \(id, confirmed = false\)/);
  assert.match(preload, /'history:recap-token'/);
  assert.match(renderer, /record\.preview \|\| ''/);
});

test('history panel loads on boot so the dock badge is accurate', () => {
  assert.match(renderer, /loadMeetingHistory\(\{ quiet: true \}\)/);
  assert.match(renderer, /meeting-history-action-count'\)\.classList\.toggle\('hidden', meetingHistoryRecords\.length === 0\)/);
  assert.match(icons, /history: '<path d="M3 12a9 9 0 1 0 9-9/);
});

test('history shows a diarization timeline that never implies a persistent identity', () => {
  assert.match(html, /id="meeting-diarization"/);
  assert.match(css, /\.history-diarization \{/);
  assert.match(css, /\.history-diarization-list \{/);
  assert.match(store, /function normalizeDiarizationRun\(run\)/);
  assert.match(store, /function updateDiarization\(id, run\)/);
  assert.match(store, /diarizationRuns: normalizeDiarizationRuns\(record\.diarizationRuns\)/);
  assert.match(store, /audioStartOffsetMs/);
  assert.match(renderer, /function renderMeetingDiarization\(\)/);
  assert.match(renderer, /System Speaker \$\{segment\.speakerId\}/);
  assert.match(renderer, /arrival order within this recording/);
  assert.match(renderer, /renderMeetingDiarization\(\);/);
  // Slots are anchored to the meeting clock, shifted by each run's own
  // recording start, not elapsed time that cannot be matched to a transcript row.
  assert.match(renderer, /function diarizationAnchor\(offsetMs = 0\)/);
  assert.match(renderer, /function diarizationRange\(startMs, endMs, anchored, offsetMs = 0\)/);
  assert.match(renderer, /const base = diarizationAnchor\(offsetMs\)/);
  assert.match(renderer, /const runOffset = Number\(run\.audioStartOffsetMs\) \|\| 0/);
  assert.match(renderer, /diarizationRange\(segment\.t0Ms, segment\.t1Ms, anchored, runOffset\)/);
  assert.match(renderer, /diarizationClock\(base \+ startMs\)/);
  // A named participant is merged into every system turn; the note must say so
  // instead of claiming turns remain You/Them.
  assert.match(renderer, /label all system audio as/);
  assert.match(html, /Other speaker \/ system audio/);
  assert.match(html, /Applies to all system audio, which may include more than one person/);
  // Bounded, scrollable, visually distinguishable slots.
  assert.match(css, /\.history-diarization-list \{[^}]*max-height:[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.history-diarization-list \{[^}]*list-style:\s*none/);
  assert.match(css, /\.history-diarization-segment\.speaker-slot-1/);
  assert.match(css, /\.history-diarization-segment\.speaker-slot-4/);
  assert.match(renderer, /MAX_RENDERED_DIARIZATION_SEGMENTS/);
  assert.match(renderer, /mergeDiarizationSegments/);
  // A run that crossed the bound was not analyzed at all; never print the
  // truncated buffer as coverage.
  assert.match(renderer, /not analyzed \(time limit\)/);
  assert.match(renderer, /duration_limit_exceeded/);
  // A speaker label must not be reachable through the transcript speaker
  // label helper, so the two surfaces cannot be conflated.
  const speakerLabel = renderer.match(/function speakerLabelFor\(channel\) \{[\s\S]*?\n  \}/);
  assert.ok(speakerLabel, 'transcript speaker labels are defined separately');
  assert.doesNotMatch(speakerLabel[0], /diarization/);
});

test('meeting memory is explicit, inspectable, and uses the trusted history bridge', () => {
  for (const id of ['meeting-memory-save', 'meeting-memory-list', 'meeting-memory-status']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const method of ['List', 'Save', 'Update', 'SetEnabled', 'Remove']) {
    assert.match(preload, new RegExp(`meetingMemory${method}:`));
  }
  for (const channel of ['memory-list', 'memory-save', 'memory-update', 'memory-set-enabled', 'memory-remove']) {
    assert.match(main, new RegExp(`handleTrusted\\('history:${channel}'`));
  }
  assert.match(renderer, /volyxLens\.meetingMemorySave\(meetingDetail\.id\)/);
  assert.match(renderer, /volyxLens\.meetingMemoryUpdate\(entry\.id, draft\)/);
  assert.match(renderer, /const meetingMemoryDrafts = new Map\(\)/);
  assert.match(renderer, /content\.addEventListener\('input', \(\) => \{\s*meetingMemoryDrafts\.set\(entry\.id, \{ text: content\.value, base: entry\.memory\.content \}\);/);
  assert.match(renderer, /content\.value = draft \? draft\.text : entry\.memory\.content/);
  assert.match(renderer, /if \(meetingMemoryDrafts\.get\(entry\.id\)\?\.text === draft\) \{/);
  assert.match(renderer, /meetingMemoryDrafts\.get\(entry\.id\)\.base = result\.memory\.content;/);
  assert.match(renderer, /const listedById = new Map\(listed\.map\(\(item\) => \[item\.id, item\]\)\);/);
  assert.match(renderer, /if \(!live \|\| live\.memory\.content !== draft\.base\) meetingMemoryDrafts\.delete\(id\);/);
  assert.match(renderer, /volyxLens\.meetingMemorySetEnabled\(entry\.id, enabled\.checked\)/);
  assert.match(renderer, /volyxLens\.meetingMemoryRemove\(entry\.id\)/);
  assert.match(renderer, /memoryButton\.disabled = !hasMeetingNotes\(meetingDetail && meetingDetail\.notes\);/);
  assert.match(renderer, /Delete the saved memory from \$\{sourceDate\}/);
  assert.match(renderer, /title\.textContent = `Meeting notes/);
  assert.match(main, /meetingStore\.saveMemoryFromNotes/);
  assert.match(main, /readOptionalContext\('saved meeting memory', \(\) => meetingStore\.searchMemories\(query\)/);
  assert.match(main, /meetingMemoryCounts/);
  assert.match(renderer, /history:changed[\s\S]*loadMeetingMemoryEntries\(\)/);
  assert.match(renderer, /unknown provenance/);
  assert.match(store, /record\.memory = null/);
  assert.match(html, /not encrypted by Volyx Lens/);
});