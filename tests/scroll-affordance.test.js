'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'e2e-smoke.js'), 'utf8');

test('the scrollbars have a resting colour instead of none', () => {
  assert.match(css, /--sb-thumb: rgba\(255, 255, 255, 0\.16\);/);
  assert.match(css, /--sb-thumb-hover: rgba\(255, 255, 255, 0\.30\);/);
  assert.doesNotMatch(css, /scrollbar-color: transparent transparent;/,
    'a scroller with no resting thumb looks truncated, not scrollable');
});

test('the panel, the answer area and settings all use it and reserve their gutter', () => {
  for (const selector of ['#panel', '#messages', '.s-pages']) {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start !== -1, `${selector} exists`);
    const rule = css.slice(start, css.indexOf('}', start));
    assert.match(rule, /scrollbar-color: var\(--sb-thumb\) transparent;/, `${selector} resting thumb`);
    assert.match(rule, /scrollbar-gutter: stable;/, `${selector} reserves its gutter`);
  }
});

test('increase contrast strengthens the thumb as well as the text', () => {
  const contrast = css.slice(css.indexOf('@media (prefers-contrast: more)'));
  assert.match(contrast, /--sb-thumb: rgba\(230, 236, 255, 0\.40\);/);
  assert.match(contrast, /--sb-thumb-hover: rgba\(230, 236, 255, 0\.62\);/);
});

test('the smoke run reads the computed scrollbar in a real window', () => {
  assert.match(smoke, /const style = getComputedStyle\(el\);/);
  assert.match(smoke, /scrollbarColor/);
  assert.match(smoke, /must not hide its scrollbar at rest/);
  assert.match(smoke, /must reserve its scrollbar gutter/);
});
