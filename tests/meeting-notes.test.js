'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { meetingFilename, meetingHeader, formatMeetingRecord, reasonLabel, normalizeTurns, localStamp } = require('../src/meeting-notes');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function sampleRecord(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    reason: 'capture-stop',
    startedAt: 1700000000000,
    endedAt: 1700003600000,
    turnCount: 3,
    turns: [
      { id: 1, channel: 'you', text: 'Hello everyone', ts: 1700000005000 },
      { id: 2, channel: 'them', text: 'Welcome to the review', ts: 1700000015000 },
      { id: 3, channel: 'you', text: 'Let us capture that decision', ts: 1700000025000 },
    ],
    ...overrides,
  };
}

test('meetingFilename stamps a supported extension with the default markdown', () => {
  const name = meetingFilename('md', 1700000000000);
  assert.match(name, /^volyx-lens-meeting-2023-11-14T22-13-20-000Z\.md$/);
  assert.match(meetingFilename('txt', 1), /\.txt$/);
  assert.match(meetingFilename('json', 1), /\.json$/);
  assert.match(meetingFilename('unknown', 1), /\.md$/, 'unknown formats fall back to markdown');
});

test('meetingHeader and reasonLabel describe the session', () => {
  const header = meetingHeader(sampleRecord());
  assert.match(header, /^# Volyx Lens meeting/);
  assert.match(header, new RegExp(`Started: ${localStamp(1700000000000)}`));
  assert.match(header, new RegExp(`Ended: ${localStamp(1700003600000)}`));
  assert.match(header, /Session end: listening stopped/);
  assert.match(header, /Turns: 3/);
  assert.equal(reasonLabel('new-session'), 'new session started');
  assert.equal(reasonLabel('app-quit'), 'app quit');
  assert.equal(reasonLabel(undefined), 'unknown');
  assert.equal(meetingHeader({ turns: null }).includes('Turns: 0'), true);
});

test('markdown export keeps all turns with speaker labels and headers', () => {
  const out = formatMeetingRecord(sampleRecord(), 'md', 1700009999999);
  assert.match(out, /^# Volyx Lens meeting/);
  assert.match(out, /- \*\*22:13:25 · You:\*\* Hello everyone/);
  assert.match(out, /- \*\*22:13:35 · Them:\*\* Welcome to the review/);
  assert.equal((out.match(/- \*\*/g) || []).length, 3, 'all three turns present');
  assert.ok(!out.includes('Volyx Lens transcript'), 'uses the meeting header, not the live-transcript one');
});

test('txt export uses bracketed timestamps', () => {
  const out = formatMeetingRecord(sampleRecord(), 'txt');
  assert.match(out, /\[22:13:25\] You: Hello everyone/);
  assert.match(out, /# Volyx Lens meeting/);
});

test('json export preserves metadata and full turn fidelity', () => {
  const parsed = JSON.parse(formatMeetingRecord(sampleRecord(), 'json', 1700009999999));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.id, sampleRecord().id);
  assert.equal(parsed.reason, 'capture-stop');
  assert.equal(parsed.startedAt, 1700000000000);
  assert.equal(parsed.endedAt, 1700003600000);
  assert.equal(parsed.exportedAt, '2023-11-15T00:59:59.999Z');
  assert.equal(parsed.turns.length, 3);
  assert.deepEqual(parsed.turns[1], { channel: 'them', text: 'Welcome to the review', ts: 1700000015000 });
});

test('exports never truncate to the live-transcript 500-turn window', () => {
  const turns = Array.from({ length: 600 }, (_, index) => ({ id: index + 1, channel: 'you', text: `Turn ${index + 1}`, ts: 1700000000000 + index }));
  const parsed = JSON.parse(formatMeetingRecord({ id: 'x', reason: 'capture-stop', startedAt: 1700000000000, endedAt: 1700000006000, turns }, 'json'));
  assert.equal(parsed.turns.length, 600);
  const md = formatMeetingRecord({ id: 'x', reason: 'capture-stop', turns }, 'md');
  assert.equal((md.match(/- \*\*/g) || []).length, 600);
});

test('normalizeTurns drops blank and non-text turns and clamps channels', () => {
  const normalized = normalizeTurns({ turns: [
    { channel: 'you', text: '  ' },
    { channel: 'them', text: 'kept', ts: 5 },
    { channel: 'unknown', text: 'clamped', ts: 6 },
    null,
    { text: 'no channel', ts: 7 },
  ] });
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].channel, 'them');
  assert.equal(normalized[1].channel, 'them');
});

test('main process exports saved records and refuses empty ones through trusted IPC', () => {
  assert.match(main, /const \{ meetingFilename, formatMeetingRecord \} = require\('\.\/src\/meeting-notes'\)/);
  assert.match(main, /async function exportMeetingRecord\(id, format\)/);
  assert.match(main, /meetingStore\.get\(String\(id \|\| ''\)\)/);
  assert.match(main, /formatMeetingRecord\(record, normalizedFormat\)/);
  assert.match(main, /handleTrusted\('history:export'/);
  assert.match(main, /handleTrusted\('history:recap'/);
});

test('structured notes run through the recap pipeline with confirmation for long meetings', () => {
  assert.match(main, /async function recapMeetingRecord\(id, options = \{\}\)/);
  assert.match(main, /planMeetingRecap\(record\.turns\)/);
  assert.match(main, /requires_confirmation/);
  assert.match(main, /requestCount/);
  assert.match(main, /summarizeMeetingChunks\(\{ plan, llm, fallback: selection\.fallback, isCurrent, signal: controller\.signal \}\)/);
  assert.match(main, /history:recap-token/);
  assert.match(main, /historyRecapController\.abort\(\)/);
  assert.match(main, /if \(state\.busy\) return \{ ok: false, code: 'answer_active'/);
});

test('preload exposes export and recap without a side-channel beyond allowed events', () => {
  assert.match(preload, /historyExport: \(id, format\) => ipcRenderer\.invoke\('history:export', \{ id, format \}\)/);
  assert.match(preload, /historyRecap: \(id, confirmed = false\) => ipcRenderer\.invoke\('history:recap', \{ id, confirmed \}\)/);
  assert.match(preload, /'history:recap-token'/);
});