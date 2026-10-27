'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const harness = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-settings-ui.js'), 'utf8');

function rule(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start !== -1, `${selector} exists`);
  return css.slice(start, css.indexOf('}', start));
}

test('the focus ring is indigo, so cyan means live capture only', () => {
  const focus = rule('button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible');
  assert.match(focus, /outline: 2px solid var\(--accent-soft\);/);
  assert.doesNotMatch(focus, /var\(--cyan\)/, 'cyan and focus are two different jobs');
  const retry = rule('.ai-retry:focus-visible');
  assert.match(retry, /outline: 2px solid var\(--accent-soft\);/);
});

test('the close button follows the palette instead of a fixed accent', () => {
  // It used to hard-code #5668E4/#4556CF, so it ignored the inactive and
  // high-contrast palettes that every other surface respects.
  const close = rule('.s-close');
  assert.match(close, /linear-gradient\(180deg, var\(--accent-hi\), var\(--accent\)\)/);
  assert.doesNotMatch(close, /#5668E4|#4556CF/i);
});

test('selection surfaces are one hue, not indigo fading into cyan', () => {
  for (const selector of ['.s-nav button.on', '.s-seg button.on']) {
    const background = rule(selector);
    assert.doesNotMatch(background, /66,\s*207,\s*232/, `${selector} must not mix in cyan`);
    assert.match(background, /rgba\(125,138,255,/, `${selector} is indigo`);
  }
});

test('the settings harness checks the computed focus ring in a real window', () => {
  assert.match(harness, /focusOutline/);
  assert.match(harness, /must not use the live-state cyan/);
});
