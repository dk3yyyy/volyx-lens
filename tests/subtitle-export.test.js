'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTranscriptSrt, formatTranscriptVtt, srtTimecode, vttTimecode } = require('../src/transcript-tools');
const { formatMeetingRecordSrt, formatMeetingRecordVtt } = require('../src/meeting-notes');

function sampleTurns() {
  return [
    { id: 1, channel: 'you', text: 'Hello world', ts: 1000 },
    { id: 2, channel: 'them', text: 'How are you', ts: 5000 },
    { id: 3, channel: 'you', text: 'I am fine', ts: 9000 },
  ];
}

test('srtTimecode formats milliseconds to SRT timecode', () => {
  assert.equal(srtTimecode(1000), '00:00:01,000');
  assert.equal(srtTimecode(5000), '00:00:05,000');
  assert.equal(srtTimecode(64000), '00:01:04,000');
  assert.equal(srtTimecode(3661001), '01:01:01,001');
  assert.equal(srtTimecode(0), '00:00:00,000');
  assert.equal(srtTimecode(-100), '00:00:00,000');
  assert.equal(srtTimecode(NaN), '00:00:00,000');
});

test('vttTimecode formats milliseconds to VTT timecode', () => {
  assert.equal(vttTimecode(1000), '00:00:01.000');
  assert.equal(vttTimecode(5000), '00:00:05.000');
  assert.equal(vttTimecode(64000), '00:01:04.000');
  assert.equal(vttTimecode(3661001), '01:01:01.001');
  assert.equal(vttTimecode(0), '00:00:00.000');
  assert.equal(vttTimecode(-100), '00:00:00.000');
  assert.equal(vttTimecode(NaN), '00:00:00.000');
});

test('formatTranscriptSrt produces valid SRT blocks with speaker labels', () => {
  const srt = formatTranscriptSrt(sampleTurns());
  const blocks = srt.trim().split('\n\n');
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /^1\n00:00:01,000 --> 00:00:05,000\nYou: Hello world$/);
  assert.match(blocks[1], /^2\n00:00:05,000 --> 00:00:09,000\nThem: How are you$/);
  assert.match(blocks[2], /^3\n00:00:09,000 --> 00:00:13,000\nYou: I am fine$/);
});

test('formatTranscriptVtt produces valid VTT blocks with WEBVTT header', () => {
  const vtt = formatTranscriptVtt(sampleTurns());
  assert.match(vtt, /^WEBVTT\n/);
  const body = vtt.replace(/^WEBVTT\n\n/, '');
  const blocks = body.trim().split('\n\n');
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /^00:00:01.000 --> 00:00:05.000\nYou: Hello world$/);
  assert.match(blocks[1], /^00:00:05.000 --> 00:00:09.000\nThem: How are you$/);
  assert.match(blocks[2], /^00:00:09.000 --> 00:00:13.000\nYou: I am fine$/);
});

test('formatTranscriptSrt handles empty turns', () => {
  assert.equal(formatTranscriptSrt([]), '');
  assert.equal(formatTranscriptSrt([{ channel: 'you', text: '', ts: 1000 }]), '');
});

test('formatTranscriptVtt handles empty turns', () => {
  assert.equal(formatTranscriptVtt([]), 'WEBVTT\n');
  assert.equal(formatTranscriptVtt([{ channel: 'you', text: '', ts: 1000 }]), 'WEBVTT\n');
});

test('formatTranscriptSrt preserves speaker labels for you and them', () => {
  const turns = [
    { channel: 'you', text: 'My line', ts: 1000 },
    { channel: 'them', text: 'Their line', ts: 5000 },
    { channel: 'unknown', text: 'Clamped to them', ts: 9000 },
  ];
  const srt = formatTranscriptSrt(turns);
  assert.match(srt, /You: My line/);
  assert.match(srt, /Them: Their line/);
  assert.match(srt, /Them: Clamped to them/);
});

test('formatTranscriptVtt preserves speaker labels for you and them', () => {
  const turns = [
    { channel: 'you', text: 'My line', ts: 1000 },
    { channel: 'them', text: 'Their line', ts: 5000 },
    { channel: 'unknown', text: 'Clamped to them', ts: 9000 },
  ];
  const vtt = formatTranscriptVtt(turns);
  assert.match(vtt, /You: My line/);
  assert.match(vtt, /Them: Their line/);
  assert.match(vtt, /Them: Clamped to them/);
});

test('formatMeetingRecordSrt produces valid SRT blocks from a record', () => {
  const record = {
    id: 'test-1',
    reason: 'capture-stop',
    startedAt: 1700000000000,
    endedAt: 1700003600000,
    turns: [
      { id: 1, channel: 'you', text: 'Hello everyone', ts: 1700000005000 },
      { id: 2, channel: 'them', text: 'Welcome to the review', ts: 1700000015000 },
    ],
  };
  const srt = formatMeetingRecordSrt(record);
  const blocks = srt.trim().split('\n\n');
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /^1\n/);
  assert.match(blocks[0], /You: Hello everyone/);
  assert.match(blocks[1], /^2\n/);
  assert.match(blocks[1], /Them: Welcome to the review/);
});

test('formatMeetingRecordVtt produces valid VTT blocks from a record', () => {
  const record = {
    id: 'test-1',
    reason: 'capture-stop',
    startedAt: 1700000000000,
    endedAt: 1700003600000,
    turns: [
      { id: 1, channel: 'you', text: 'Hello everyone', ts: 1700000005000 },
      { id: 2, channel: 'them', text: 'Welcome to the review', ts: 1700000015000 },
    ],
  };
  const vtt = formatMeetingRecordVtt(record);
  assert.match(vtt, /^WEBVTT\n/);
  const body = vtt.replace(/^WEBVTT\n\n/, '');
  const blocks = body.trim().split('\n\n');
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /You: Hello everyone/);
  assert.match(blocks[1], /Them: Welcome to the review/);
});

test('formatMeetingRecordSrt handles empty record', () => {
  assert.equal(formatMeetingRecordSrt({ turns: [] }), '');
  assert.equal(formatMeetingRecordSrt({}), '');
});

test('formatMeetingRecordVtt handles empty record', () => {
  assert.equal(formatMeetingRecordVtt({ turns: [] }), 'WEBVTT\n');
  assert.equal(formatMeetingRecordVtt({}), 'WEBVTT\n');
});
