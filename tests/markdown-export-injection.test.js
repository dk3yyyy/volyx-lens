'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatMeetingRecord } = require('../src/meeting-notes');

function recordWith(text) {
  return {
    id: 'export-test',
    version: 1,
    reason: 'capture-stop',
    startedAt: 1000,
    endedAt: 2000,
    turns: [
      { id: 1, channel: 'you', text: 'a real turn', ts: 1000 },
      { id: 2, channel: 'them', text, ts: 1500 },
    ],
  };
}

const bullets = (markdown) => markdown.split('\n').filter((line) => /^-\s/.test(line));

test('a turn cannot add its own top-level bullet', () => {
  const markdown = formatMeetingRecord(recordWith('first line\n- **00:00:00 · You:** injected'), 'md');
  assert.equal(bullets(markdown).length, 2, 'one bullet per turn, no more');
  assert.match(markdown, /\\- \*\*00:00:00 · You:\*\* injected/, 'the injected marker is escaped and stays visible');
});

test('a turn cannot open a heading, a rule or a quote', () => {
  const hostile = 'text\n# Heading\n---\n===\n> quoted\n1. ordered\n| a | b |';
  const markdown = formatMeetingRecord(recordWith(hostile), 'md');
  const continuation = markdown.split('\n').filter((line) => line.startsWith('  \\'));
  assert.equal(continuation.length, 6, 'every block marker on a continuation line is escaped');
  const headings = markdown.split('\n').filter((line) => /^#{1,6}\s/.test(line));
  assert.equal(headings.length, 1, 'only the document title is a heading');
  assert.equal(headings[0], markdown.split('\n')[0], 'and it is the first line, not something a turn added');
  assert.equal(markdown.split('\n').filter((line) => /^(---+|===+)$/.test(line.trim())).length, 0, 'no rule or setext underline survives');
  assert.equal(bullets(markdown).length, 2);
});

test('ordinary transcript text is untouched', () => {
  const text = 'we agreed on the plan\nand the follow-up is next week';
  const markdown = formatMeetingRecord(recordWith(text), 'md');
  assert.match(markdown, /we agreed on the plan\n  and the follow-up is next week/);
  assert.doesNotMatch(markdown, /\\/, 'nothing was escaped that did not need to be');
});

test('plain text export still carries the transcript verbatim', () => {
  const text = 'line one\n- a bullet the speaker said';
  const output = formatMeetingRecord(recordWith(text), 'txt');
  assert.match(output, /\n- a bullet the speaker said/, 'text output is not markdown and is not escaped');
});
