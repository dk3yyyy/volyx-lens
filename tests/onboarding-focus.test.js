'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const harness = fs.readFileSync(path.join(root, 'scripts', 'check-onboarding-ui.js'), 'utf8');

test('the onboarding heading retries focus until it holds, then stops', () => {
  assert.doesNotMatch(renderer, /\[0, 120, 400\]\.forEach\(\(delay\) => setTimeout\(focusTitle, delay\)\)/, 'a fixed retry schedule can miss every window');
  assert.match(renderer, /let focusAttempts = 0;/);
  assert.match(renderer, /if \(document\.activeElement === title\) return;/, 'it stops as soon as focus holds');
  assert.match(renderer, /if \(focusAttempts < 30\) setTimeout\(focusTitle, 50\);/, 'the retry is bounded');
});

test('the retry never fights the user for the keyboard', () => {
  // Only an unfocused dialog is refocused: anything else with focus is treated as
  // the user having moved, which is what keeps this from stealing the caret.
  assert.match(renderer, /const current = document\.activeElement;/);
  assert.match(renderer, /if \(current && current !== document\.body && current !== obScrim\) return;/);
});

test('the dialog is only refocused while it is open', () => {
  assert.match(renderer, /if \(obScrim\.classList\.contains\('hidden'\)\) return;/);
  assert.match(renderer, /requestAnimationFrame\(focusTitle\)/, 'the first attempt waits for a painted frame');
});

test('the harness re-asks the runner for window focus on every attempt', () => {
  assert.match(harness, /async function waitFor\(win, expression, message, timeoutMs = 2500, onAttempt = null\)/);
  assert.match(harness, /if \(onAttempt\) await onAttempt\(\);/);
  assert.match(harness, /\(\) => \{ win\.show\(\); win\.focus\(\); win\.webContents\.focus\(\); \}/);
  assert.match(harness, /'initial onboarding heading focus',\s*10000,/, 'the cold-start window is still ten seconds');
});
