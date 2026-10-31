'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveHistoryEnabled } = require('../src/history-default');

test('a fresh profile starts with meeting history on', () => {
  assert.equal(resolveHistoryEnabled({ hadSettingsFile: false, storedValue: undefined }), true);
});

test('an existing profile without a stored choice keeps history off', () => {
  assert.equal(resolveHistoryEnabled({ hadSettingsFile: true, storedValue: undefined }), false);
});

test('a stored choice always wins over both defaults', () => {
  assert.equal(resolveHistoryEnabled({ hadSettingsFile: false, storedValue: false }), false);
  assert.equal(resolveHistoryEnabled({ hadSettingsFile: true, storedValue: true }), true);
});

test('an unusable stored value is treated as no choice', () => {
  for (const storedValue of [null, 'yes', 1, {}]) {
    assert.equal(resolveHistoryEnabled({ hadSettingsFile: false, storedValue }), true);
    assert.equal(resolveHistoryEnabled({ hadSettingsFile: true, storedValue }), false);
  }
});
