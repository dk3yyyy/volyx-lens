'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderNotesHtml, escapeText } = require('../renderer/notes-markup');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

test('a payload shaped like markup renders as text, not as elements', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const out = renderNotesHtml({
    summary: hostile,
    keyPoints: [hostile, 'A normal point'],
    actionItems: ['<script>alert(2)</script>'],
  });
  assert.doesNotMatch(out, /<img/, 'the image tag is escaped');
  assert.doesNotMatch(out, /<script/i, 'the script tag is escaped');
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /A normal point/);
});

test('escaping covers the characters that break out of text and attributes', () => {
  assert.equal(escapeText(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
  assert.equal(escapeText(null), '');
  assert.equal(escapeText(undefined), '');
});

test('the raw fallback is escaped too', () => {
  const out = renderNotesHtml(null, '<b>unparsed notes</b>');
  assert.match(out, /^<div><pre class="notes-raw">&lt;b&gt;unparsed notes&lt;\/b&gt;<\/pre><\/div>$/);
});

test('a well-formed note still renders its sections and list items', () => {
  const out = renderNotesHtml({
    summary: 'We agreed the plan.',
    keyPoints: ['One', 'Two'],
    decisions: [],
    actionItems: ['Ship it'],
    followUp: 'Next week',
  });
  assert.match(out, /<section class="notes-section"><h4>📋 Meeting Summary<\/h4><p>We agreed the plan\.<\/p><\/section>/);
  assert.match(out, /<ul><li>One<\/li><li>Two<\/li><\/ul>/);
  assert.doesNotMatch(out, /Decisions/, 'an empty section is still skipped');
});

test('the renderer uses the escaping builder and loads it before itself', () => {
  assert.match(renderer, /const \{ renderNotesHtml \} = window\.volyxLensNotesMarkup;/);
  assert.match(renderer, /out\.innerHTML = renderNotesHtml\(/);
  assert.doesNotMatch(renderer, /function renderStructuredNotes/, 'the concatenating builder is gone');
  assert.match(html, /<script src="notes-markup\.js"><\/script>[\s\S]*<script src="renderer\.js"><\/script>/);
});
