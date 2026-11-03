'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatLastChecked, formatRelativeTime } = require('../renderer/relative-time');

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function shortDate(timestamp) {
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

test('a missing or zero timestamp reads as never checked', () => {
  // 0 is the sentinel an older serialization used for "no timestamp"; it must
  // not render as 1970 or as a negative duration.
  for (const value of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '']) {
    assert.equal(formatLastChecked(value, NOW), 'Never checked', `value ${String(value)}`);
    assert.equal(formatRelativeTime(value, NOW), '', `value ${String(value)}`);
  }
});

test('a check seconds ago reads as just now', () => {
  assert.equal(formatLastChecked(NOW - 1000, NOW), 'Last checked just now');
  assert.equal(formatRelativeTime(NOW - 59 * 1000, NOW), 'just now');
  // A clock that moved backwards must not produce "-1 minutes ago".
  assert.equal(formatLastChecked(NOW + 5000, NOW), 'Last checked just now');
});

test('minutes and hours are counted with singular labels at one', () => {
  assert.equal(formatLastChecked(NOW - MINUTE, NOW), 'Last checked 1 minute ago');
  assert.equal(formatLastChecked(NOW - 2 * MINUTE, NOW), 'Last checked 2 minutes ago');
  assert.equal(formatLastChecked(NOW - 59 * MINUTE, NOW), 'Last checked 59 minutes ago');
  assert.equal(formatLastChecked(NOW - HOUR, NOW), 'Last checked 1 hour ago');
  assert.equal(formatLastChecked(NOW - 3 * HOUR, NOW), 'Last checked 3 hours ago');
  assert.equal(formatLastChecked(NOW - 23 * HOUR, NOW), 'Last checked 23 hours ago');
});

test('a check a day or more old becomes a short date', () => {
  for (const age of [DAY, 3 * DAY, 40 * DAY]) {
    const timestamp = NOW - age;
    assert.equal(formatLastChecked(timestamp, NOW), `Last checked ${shortDate(timestamp)}`);
    assert.doesNotMatch(formatLastChecked(timestamp, NOW), /ago/);
  }
});

test('the formatter uses the supplied clock instead of the wall clock', () => {
  const timestamp = NOW - 5 * MINUTE;
  assert.equal(formatLastChecked(timestamp, NOW), 'Last checked 5 minutes ago');
  assert.equal(formatLastChecked(timestamp, NOW + 5 * MINUTE), 'Last checked 10 minutes ago');
});
