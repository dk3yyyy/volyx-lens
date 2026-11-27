'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readOptionalContext } = require('../src/optional-context');

test('optional context returns a valid match array unchanged', () => {
  const matches = [{ id: 'one' }];
  for (const label of ['workspace', 'saved meeting memory']) {
    assert.equal(readOptionalContext(label, () => matches), matches);
  }
});

test('optional context converts lookup failures into an empty result and reports the error', () => {
  const failure = new Error('database is locked');
  const reported = [];
  const matches = readOptionalContext('workspace', () => { throw failure; }, {
    onError: (label, error) => reported.push({ label, error }),
  });

  assert.deepEqual(matches, []);
  assert.deepEqual(reported, [{ label: 'workspace', error: failure }]);
  readOptionalContext('saved meeting memory', () => { throw failure; }, {
    onError: (label, error) => reported.push({ label, error }),
  });
  assert.deepEqual(reported, [
    { label: 'workspace', error: failure },
    { label: 'saved meeting memory', error: failure },
  ]);
});

test('optional context rejects malformed non-array results without leaking them into prompts', () => {
  assert.deepEqual(readOptionalContext('memory', () => ({ unexpected: true })), []);
  assert.deepEqual(readOptionalContext('memory', () => null), []);
});
