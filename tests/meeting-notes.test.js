'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { meetingFilename, meetingHeader, formatMeetingRecord, reasonLabel, normalizeTurns, resolveTurns, localStamp } = require('../src/meeting-notes');

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
  assert.match(header, /^# Volyx Lens session/);
  assert.ok(!header.includes('detected as a two-sided conversation'), 'no meeting line without the flag');
  assert.match(header, new RegExp(`Started: ${localStamp(1700000000000)}`));
  assert.match(header, new RegExp(`Ended: ${localStamp(1700003600000)}`));
  assert.match(header, /Session end: listening stopped/);
  assert.match(header, /Turns: 3/);
  const meetingHeader2 = meetingHeader(sampleRecord({ meeting: true }));
  assert.match(meetingHeader2, /^# Volyx Lens meeting/);
  assert.match(meetingHeader2, /Meeting: detected as a two-sided conversation/);
  assert.equal(reasonLabel('new-session'), 'new session started');
  assert.equal(reasonLabel('app-quit'), 'app quit');
  assert.equal(reasonLabel(undefined), 'unknown');
  assert.equal(meetingHeader({ turns: null }).includes('Turns: 0'), true);
});

test('markdown export keeps all turns with speaker labels and headers', () => {
  const out = formatMeetingRecord(sampleRecord({ meeting: true }), 'md', 1700009999999);
  assert.match(out, /^# Volyx Lens meeting/);
  assert.match(out, /Meeting: detected as a two-sided conversation/);
  assert.match(out, /- \*\*22:13:25 · You:\*\* Hello everyone/);
  assert.match(out, /- \*\*22:13:35 · Them:\*\* Welcome to the review/);
  assert.equal((out.match(/- \*\*/g) || []).length, 3, 'all three turns present');
  assert.ok(!out.includes('Volyx Lens transcript'), 'uses the meeting header, not the live-transcript one');
});

test('txt export uses bracketed timestamps', () => {
  const out = formatMeetingRecord(sampleRecord(), 'txt');
  assert.match(out, /\[22:13:25\] You: Hello everyone/);
  assert.match(out, /# Volyx Lens session/);
});

test('json export carries diarization sidecars without adding audio', () => {
  const record = {
    id: 'x',
    turns: [{ channel: 'them', text: 'Hello', ts: 1 }],
    diarizationRuns: [{
      version: 1,
      recordingId: 'diar-run-1',
      sourceChannel: 'them',
      status: 'ready',
      modelId: 'diar-sortformer-4spk',
      artifactSha256: 'a'.repeat(64),
      preset: 'very_high_latency',
      sampleRate: 16000,
      durationMs: 5000,
      segments: [{ speakerId: 1, t0Ms: 100, t1Ms: 2000 }],
    }],
  };
  const parsed = JSON.parse(formatMeetingRecord(record, 'json', 2));
  assert.equal(parsed.diarizationRuns.length, 1);
  assert.equal(parsed.diarizationRuns[0].segments[0].speakerId, 1);
  assert.equal('audio' in parsed.diarizationRuns[0], false, 'the sidecar carries timestamps only, never an audio payload');
});

test('non-json exports stay transcript-only and omit the diarization sidecar', () => {
  const record = {
    id: 'x',
    turns: [{ channel: 'them', text: 'Hello', ts: 1 }],
    diarizationRuns: [{
      version: 1,
      recordingId: 'diar-run-1',
      sourceChannel: 'them',
      status: 'ready',
      modelId: 'diar-sortformer-4spk',
      artifactSha256: 'a'.repeat(64),
      preset: 'very_high_latency',
      sampleRate: 16000,
      durationMs: 5000,
      segments: [{ speakerId: 2, t0Ms: 100, t1Ms: 2000 }],
    }],
  };
  for (const format of ['md', 'txt', 'srt', 'vtt']) {
    assert.doesNotMatch(formatMeetingRecord(record, format, 2), /System Speaker|diarization/i, `${format} export has no sidecar`);
  }
});

test('raw exports use original recognizer wording when deterministic processing changed it', () => {
  const record = {
    id: 'x',
    turns: [{ channel: 'you', text: 'Volyx Lens', rawText: 'volyx lens', ts: 1 }],
  };
  const markdown = formatMeetingRecord(record, 'md', 2, { source: 'raw' });
  assert.match(markdown, /volyx lens/);
  assert.doesNotMatch(markdown, /You:\*\* Volyx Lens/);
  const automatic = formatMeetingRecord(record, 'md', 2);
  assert.match(automatic, /You:\*\* Volyx Lens/);
  const parsed = JSON.parse(formatMeetingRecord(record, 'json', 2));
  assert.equal(parsed.turns[0].rawText, 'volyx lens');
});

test('rawText-only records retain distinct deterministic-processing provenance', () => {
  const record = {
    turns: [{ channel: 'you', text: 'Volyx Lens', rawText: 'volyx lens', ts: 1 }],
  };
  const automatic = resolveTurns(record);
  assert.equal(automatic.cleaned, false, 'no AI-cleaned copy exists');
  assert.equal(automatic.processed, true, 'the readable text came from deterministic processing');
  assert.equal(automatic.turns[0].text, 'Volyx Lens');

  const raw = resolveTurns(record, { source: 'raw' });
  assert.equal(raw.cleaned, false);
  assert.equal(raw.processed, false, 'an explicitly raw view is original recognizer wording');
  assert.equal(raw.turns[0].text, 'volyx lens');

  const unchanged = resolveTurns({ turns: [{ channel: 'you', text: 'Hello everyone', ts: 2 }] });
  assert.equal(unchanged.processed, false, 'ordinary recognizer text is still raw provenance');
});

test('json export preserves metadata and full turn fidelity', () => {
  const parsed = JSON.parse(formatMeetingRecord(sampleRecord({ meeting: true }), 'json', 1700009999999));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.id, sampleRecord().id);
  assert.equal(parsed.reason, 'capture-stop');
  assert.equal(parsed.meeting, true);
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
  assert.match(main, /const \{ meetingFilename, formatMeetingRecord, resolveTurns \} = require\('\.\/src\/meeting-notes'\)/);
  assert.match(main, /async function exportMeetingRecord\(id, format, source\)/);
  assert.match(main, /meetingStore\.get\(String\(id \|\| ''\)\)/);
  assert.match(main, /formatMeetingRecord\(record, normalizedFormat, Date\.now\(\), \{ source: normalizedSource \}\)/);
  assert.match(main, /handleTrusted\('history:export'/);
  assert.match(main, /handleTrusted\('history:recap'/);
});

test('structured notes run through the recap pipeline with confirmation for long meetings', () => {
  assert.match(main, /async function recapMeetingRecord\(id, options = \{\}\)/);
  assert.match(main, /const \{ turns: readableTurns, cleaned: readingCleaned, processed: readingProcessed \} = resolveTurns\(record\);/);
  assert.match(main, /planMeetingRecap\(readableTurns\)/);
  assert.match(main, /requires_confirmation/);
  assert.match(main, /requestCount/);
  assert.match(main, /summarizeMeetingChunks\(\{ plan, llm, fallback: selection\.fallback, isCurrent, signal: controller\.signal \}\)/);
  assert.match(main, /history:recap-token/);
  assert.match(main, /abortActiveHistoryJob\(\)/);
  assert.match(main, /if \(state\.busy\) return \{ ok: false, code: 'answer_active'/);
});

test('preload exposes export and recap without a side-channel beyond allowed events', () => {
  assert.match(preload, /historyExport: \(id, format, source = 'auto'\) => ipcRenderer\.invoke\('history:export', \{ id, format, source \}\)/);
  assert.match(preload, /historyRecap: \(id, confirmed = false\) => ipcRenderer\.invoke\('history:recap', \{ id, confirmed \}\)/);
  assert.match(preload, /'history:recap-token'/);
});
function cleanedRecord(overrides = {}) {
  const record = sampleRecord(overrides);
  record.cleaned = {
    version: 1,
    at: 1700004000000,
    model: 'deepseek-flash',
    texts: record.turns.map((_, index) => `Cleaned line ${index + 1}.`),
  };
  return record;
}

test('markdown and text exports use the cleaned copy and say so', () => {
  const record = cleanedRecord();
  const md = formatMeetingRecord(record, 'md', 1700009999999);
  assert.match(md, /Cleaned line 1\./);
  assert.doesNotMatch(md, new RegExp(record.turns[0].text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(md, /Transcript: cleaned copy/);

  const txt = formatMeetingRecord(record, 'txt');
  assert.match(txt, /Cleaned line 2\./);
  assert.match(txt, /Transcript: cleaned copy/);
});

test('subtitle exports stay literal because a subtitle file has no notice slot', () => {
  const record = cleanedRecord();
  assert.match(formatMeetingRecord(record, 'srt'), new RegExp(record.turns[0].text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(formatMeetingRecord(record, 'srt'), /Cleaned line 1\./);
  assert.doesNotMatch(formatMeetingRecord(record, 'vtt'), /Cleaned line 3\./);
  assert.doesNotMatch(formatMeetingRecord(record, 'vtt'), /Transcript: cleaned copy/);
});

test('exports fall back to the raw wording when the cleaned copy is not parallel', () => {
  const record = sampleRecord();
  record.cleaned = { version: 1, texts: ['Only one line.'] };
  const md = formatMeetingRecord(record, 'md');
  assert.match(md, new RegExp(record.turns[0].text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(md, /Only one line\./);
  assert.doesNotMatch(md, /Transcript: cleaned copy/);
});

test('json export keeps the raw transcript and carries the cleaned copy alongside', () => {
  const record = cleanedRecord();
  const parsed = JSON.parse(formatMeetingRecord(record, 'json', 1700009999999));
  assert.equal(parsed.turns[0].text, record.turns[0].text, 'raw wording preserved in json');
  assert.equal(parsed.cleaned.texts[0], 'Cleaned line 1.');
  assert.equal(parsed.cleaned.model, 'deepseek-flash');
});

test('exports name the other speaker when the meeting has one', () => {
  const record = sampleRecord({ participant: 'Ada Lovelace' });
  const md = formatMeetingRecord(record, 'md');
  const txt = formatMeetingRecord(record, 'txt');
  const srt = formatMeetingRecord(record, 'srt');
  assert.match(md, /Ada Lovelace:/);
  assert.doesNotMatch(md, /Them:/);
  assert.match(txt, /Ada Lovelace:/);
  assert.match(srt, /Ada Lovelace:/);
  assert.match(md, /Participants: You, Ada Lovelace/);
});

test('a meeting with no named participant still reads as Them', () => {
  const record = sampleRecord();
  assert.match(formatMeetingRecord(record, 'md'), /Them:/);
  assert.doesNotMatch(formatMeetingRecord(record, 'md'), /Participants:/);
});

test('processed export keeps the saved deterministic wording over the cleaned copy', () => {
  const record = {
    turns: [{ channel: 'you', text: 'Volyx Lens', rawText: 'volyx lens', ts: 1 }],
    cleaned: { texts: ['Volyx Lens, cleaned'] },
  };
  const automatic = resolveTurns(record);
  assert.equal(automatic.turns[0].text, 'Volyx Lens, cleaned', 'auto prefers the AI-cleaned copy');
  assert.equal(automatic.cleaned, true);

  const processed = resolveTurns(record, { source: 'processed' });
  assert.equal(processed.cleaned, false);
  assert.equal(processed.turns[0].text, 'Volyx Lens', 'the selected Processed view is what gets exported');
});
