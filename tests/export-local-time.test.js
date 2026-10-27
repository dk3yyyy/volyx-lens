'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const modulePath = path.join(__dirname, '..', 'src', 'meeting-notes.js');

function formatUnderTimezone(timezone) {
  const script = `
    const { formatMeetingRecord } = require(${JSON.stringify(modulePath)});
    const ts = Date.UTC(2026, 9, 27, 18, 5, 1);
    const record = {
      id: 'export-test', version: 1, reason: 'capture-stop', meeting: false,
      startedAt: ts - 60000, endedAt: ts,
      turns: [{ id: 1, channel: 'you', text: 'the only turn', ts }],
    };
    process.stdout.write(formatMeetingRecord(record, 'md'));
  `;
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: timezone },
    encoding: 'utf8',
  });
}

test('one exported document does not mix UTC and local times', () => {
  const output = formatUnderTimezone('America/New_York');
  const header = output.match(/Started:\s*[0-9-]+\s+(\d{2}):(\d{2})/);
  const firstTurn = output.match(/^- \*\*(\d{2}):(\d{2}):(\d{2}) · /m);
  assert.ok(header, 'the header carries a start time');
  assert.ok(firstTurn, 'the first turn carries a time label');
  const headerSeconds = (Number(header[1]) * 3600) + (Number(header[2]) * 60);
  const turnSeconds = (Number(firstTurn[1]) * 3600) + (Number(firstTurn[2]) * 60) + Number(firstTurn[3]);
  // The turn is thirty seconds after the record started, so the two labels are
  // adjacent. A UTC label against a local header is four hours off, not two minutes.
  assert.ok(
    Math.abs(turnSeconds - headerSeconds) <= 120,
    `the header (${header[1]}:${header[2]}) and the first turn (${firstTurn[1]}:${firstTurn[2]}) must describe the same wall clock`,
  );
});

test('the turn label is the local wall clock, not UTC', () => {
  const output = formatUnderTimezone('America/New_York');
  const firstTurn = output.match(/^- \*\*(\d{2}):(\d{2}):(\d{2}) · /m);
  // 18:05 UTC on 27 October is 14:05 in New York.
  assert.equal(`${firstTurn[1]}:${firstTurn[2]}`, '14:05');
});
