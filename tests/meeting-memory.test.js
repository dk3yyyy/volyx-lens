const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildPreviousMeetingsBlock,
  DEFAULT_MEMORY_MEETINGS,
  DEFAULT_MEMORY_CHARS,
} = require('../src/meeting-memory');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function meeting({ summary, endedAt = 0, startedAt = 0, extraNotes = {} } = {}) {
  return {
    endedAt,
    startedAt,
    notes: summary == null ? null : { summary, ...extraNotes },
  };
}

test('previous meetings use written summaries with dates, newest first as supplied', () => {
  const block = buildPreviousMeetingsBlock([
    meeting({ summary: 'Agreed to move the migration into its own milestone.', endedAt: Date.UTC(2026, 9, 20) }),
    meeting({ summary: 'Pricing stayed at the current tier.', endedAt: Date.UTC(2026, 9, 18) }),
  ]);

  assert.equal(block.count, 2);
  assert.match(block.text, /^- 2026-10-20: Agreed to move the migration/m);
  assert.match(block.text, /^- 2026-10-18: Pricing stayed/m);
});

test('only meetings with notes contribute, and raw transcripts never do', () => {
  const block = buildPreviousMeetingsBlock([
    meeting({ summary: null }),
    { endedAt: 1, notes: null, preview: 'Them: confidential raw transcript' },
    meeting({ summary: 'Real summary.', endedAt: Date.UTC(2026, 9, 21) }),
  ]);

  assert.equal(block.count, 1);
  assert.doesNotMatch(block.text, /confidential raw transcript/);
});

test('the block is bounded by meeting count and characters', () => {
  const records = Array.from({ length: 10 }, (_, index) => meeting({
    summary: 'x'.repeat(900),
    endedAt: Date.UTC(2026, 9, 20 - index),
  }));
  const block = buildPreviousMeetingsBlock(records);

  assert.equal(block.count, DEFAULT_MEMORY_MEETINGS);
  assert.ok(block.text.length <= DEFAULT_MEMORY_CHARS, `expected <= ${DEFAULT_MEMORY_CHARS}, got ${block.text.length}`);
  for (const line of block.text.split('\n')) assert.ok(line.length <= 401, 'each entry stays near the per-meeting cap');
});

test('an empty history produces no block at all', () => {
  assert.deepEqual(buildPreviousMeetingsBlock([]), { text: '', count: 0 });
  assert.deepEqual(buildPreviousMeetingsBlock(null), { text: '', count: 0 });
  assert.deepEqual(buildPreviousMeetingsBlock([meeting({ summary: '' })]), { text: '', count: 0 });
});

test('main only attaches previous meetings when history and meeting memory are enabled', () => {
  const main = read('main.js');

  assert.match(main, /buildPreviousMeetingsBlock/);
  assert.match(main, /settings\.transcription\.historyEnabled/);
  assert.match(main, /settings\.transcription\.meetingMemory === true/);
  assert.match(main, /buildMemorySearchQuery\(userText, recentTranscriptText\)/);
  assert.match(main, /function readMeetingMemoryMatches\(query\)/);
  assert.match(main, /readMeetingMemoryMatches\(query\)[\s\S]*?historyEnabled === true[\s\S]*?meetingMemory === true/);
  assert.match(main, /readOptionalContext\('saved meeting memory', \(\) => meetingStore\.searchMemories\(query\)/);
  assert.match(main, /match\.excerpt/);
  assert.match(main, /formatInspectableMemoryContext\(meetingMemoryMatches\)/);
  assert.match(main, /const initialMeetingMemoryMatches = PREVIOUS_MEETINGS_MODES\.has\(mode\)/);
  const finalLookup = main.indexOf('const meetingMemoryMatches = readMeetingMemoryMatches(memoryRelevanceQuery);');
  const screenshotAwait = main.indexOf('await captureScreenshot(', main.indexOf('async function runFeature('));
  const providerDispatch = main.indexOf('const fullAnswer = await streamWithFallback(', finalLookup);
  assert.ok(finalLookup > screenshotAwait, 'saved memory is retrieved again after screenshot capture');
  assert.ok(providerDispatch > finalLookup, 'the refreshed memory is used for provider dispatch');
  assert.equal(main.slice(finalLookup, providerDispatch).includes('await '), false, 'no await separates revalidation from dispatch');
  assert.match(main, /if entries conflict, state the conflict and cite the source meeting date/);
  assert.match(main, /meetingMemorySources/);
  assert.match(main, /PREVIOUS_MEETINGS_MODES/);
  assert.match(main, /previousMeetingsCache/);
  assert.match(main, /const stored = meetingStore\.updateNotes\(record\.id, notes\);/);
  assert.match(main, /if \(!stored\.updated\)/);
  assert.match(main, /invalidatePreviousMeetings\(\);/);
  assert.match(main, /\.filter\(\(entry\) => entry\.hasNotes\)[\s\S]{0,40}\.slice\(0, 8\)/);
});
