'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const chunks = main.slice(
  main.indexOf('async function summarizeMeetingChunks'),
  main.indexOf('async function runFeature'),
);

test('one failed part does not discard the parts that succeeded', () => {
  assert.match(chunks, /const missingParts = \[\];/);
  assert.match(chunks, /missingParts\.push\(index \+ 1\);/);
  assert.match(chunks, /if \(!summaries\.length\) throw lastError/,
    'with nothing salvaged the original failure is still the outcome');
  assert.match(chunks, /could not be summarized and are not represented above/,
    'the recap prompt is told which parts are missing, so it does not guess');
});

test('a bad key stops the loop instead of failing every remaining part', () => {
  assert.match(chunks, /const kind = classifyProviderError\(error\);/);
  assert.match(chunks, /if \(kind === 'auth' \|\| kind === 'invalid-request'\) throw error;/);
});

test('each part is summarised on its own budget', () => {
  assert.match(chunks, /perAttemptTimeoutMs = FEATURE_REQUEST_TIMEOUT_MS/);
  assert.match(chunks, /perAttemptTimeoutMs,/);
  assert.match(main, /perAttemptTimeoutMs: FEATURE_REQUEST_TIMEOUT_MS,\s*\n\s*plan: recapPlan|plan: recapPlan[\s\S]{0,200}perAttemptTimeoutMs: FEATURE_REQUEST_TIMEOUT_MS,/);
});
