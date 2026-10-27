'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

test('a provider error keeps the streamed answer and marks the failure beside it', () => {
  const handler = renderer.slice(
    renderer.indexOf("volyxLens.on('llm:error'"),
    renderer.indexOf("volyxLens.on('llm:error'") + 700,
  );
  assert.match(handler, /const streamed = Boolean\(aiEl && \(aiEl\.dataset\.raw \|\| ''\)\.trim\(\)\);/);
  assert.match(handler, /if \(streamed\) \{[\s\S]*finalizeAi\('Response interrupted\.'\);[\s\S]*appendAnswerError\(message\);/,
    'streamed content is finalised, not replaced');
  assert.doesNotMatch(handler.slice(0, handler.indexOf('appendAnswerError(message)')), /aiEl\.dataset\.raw = message/,
    'the error string is never written over the streamed text');
});

test('the error block is only built when nothing streamed', () => {
  const handler = renderer.slice(renderer.indexOf("volyxLens.on('llm:error'"));
  const streamedBranch = handler.slice(0, handler.indexOf('return;'));
  assert.doesNotMatch(streamedBranch, /startAi\(/);
  const fallback = handler.slice(handler.indexOf('return;'), handler.indexOf("volyxLens.on('status'"));
  assert.match(fallback, /startAi\(true\);/);
  assert.match(fallback, /aiEl\.dataset\.raw = message;/);
});

test('retry is offered only when the request that failed is known', () => {
  assert.match(renderer, /let lastRequest = null;/);
  assert.match(renderer, /lastRequest = \{ mode, text: text \|\| '', confirmedLongRecap: options\.confirmedLongRecap === true \};\s*\n\s*volyxLens\.ask\(\{ \.\.\.lastRequest \}\);/);
  assert.match(renderer, /if \(lastRequest\) \{[\s\S]{0,200}retry\.textContent = 'Retry';/);
  assert.match(renderer, /setBusy\(true, lastRequest\.mode\);\s*\n\s*volyxLens\.ask\(\{ \.\.\.lastRequest \}\);/);
});

test('the error block is styled as a distinct surface', () => {
  assert.match(styles, /\.ai-error \{/);
  assert.match(styles, /\.ai-retry \{/);
  assert.match(styles, /\.ai-retry:focus-visible/);
});
