'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const harness = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-settings-ui.js'), 'utf8');
const sections = ['providers', 'listening', 'context', 'shortcuts', 'updates', 'help'];

test('each settings section button names the page it controls', () => {
  for (const section of sections) {
    assert.match(html, new RegExp(`data-settings-section="${section}" aria-controls="settings-page-${section}"`), section);
    assert.match(html, new RegExp(`<section class="s-page[^"]*" id="settings-page-${section}"`), `${section} page id`);
  }
});

test('the current section is exposed, not just styled', () => {
  assert.match(renderer, /if \(active\) button\.setAttribute\('aria-current', 'page'\);/);
  assert.match(renderer, /else button\.removeAttribute\('aria-current'\);/);
});

test('provider tabs report selection and keep one tab stop', () => {
  assert.match(renderer, /button\.setAttribute\('aria-selected', String\(selected\)\);/);
  assert.match(renderer, /button\.tabIndex = selected \? 0 : -1;/);
  assert.match(renderer, /setAttribute\('aria-labelledby', `provider-tab-\$\{providerView\}`\)/);
});

test('the harness proves the semantics in a real window', () => {
  assert.match(harness, /assert\.equal\(semantics\.currentCount, 1,/);
  assert.match(harness, /'aria-controls points at the visible page'/);
  assert.match(harness, /assert\.equal\(providerSemantics\.selected, 1,/);
  assert.match(harness, /assert\.equal\(providerSemantics\.roving, 1,/);
});
