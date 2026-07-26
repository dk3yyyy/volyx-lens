const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SOURCE_UNCERTAINTY_RULE } = require('../src/response-context');
const { MODES } = require('../src/prompts');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

test('all model requests receive an explicit uncertainty and no-guessing rule', () => {
  assert.match(SOURCE_UNCERTAINTY_RULE, /unclear|ambiguous/i);
  assert.match(SOURCE_UNCERTAINTY_RULE, /do not guess|never guess/i);
  assert.match(main, /SOURCE_UNCERTAINTY_RULE/);
  assert.match(main, /Summarize this sequential meeting-transcript part[^`]*\$\{SOURCE_UNCERTAINTY_RULE\}/);
});

test('main process uses bounded chat history for typed follow-ups and clears it with the session', () => {
  assert.match(main, /createChatHistory/);
  assert.match(main, /chatHistory\.turnsFor\(built\)/);
  assert.match(main, /if \(mode === 'ask'\) chatHistory\.addExchange/);
  assert.match(main, /resetTranscriptData\(\);\n\s*chatHistory\.clear\(\);/);
  assert.match(main, /handleTrusted\('transcript:clear'[\s\S]*?resetTranscriptData\(\);\n\s*chatHistory\.clear\(\);/);
});

test('main process resolves screen attachment and missing conversation before provider work', () => {
  assert.match(main, /shouldAttachScreen\(\{ mode, userText:/);
  assert.match(main, /requiresVision: mode === 'leetcode' \|\| \(mode === 'ask' && needsScreen\)/);
  assert.match(main, /missingContextMessage\(\{ mode, transcript:/);
});

test('composer tells users how to explicitly request screen context', () => {
  assert.match(html, /screen:/i);
});

test('typed-chat prompt does not claim that a screenshot is always present', () => {
  assert.equal(MODES.ask.needsScreen, false);
  assert.match(MODES.ask.system, /when attached|if attached/i);
});
