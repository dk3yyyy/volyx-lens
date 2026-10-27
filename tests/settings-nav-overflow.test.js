'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const harness = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-settings-ui.js'), 'utf8');

const compact = css.slice(css.indexOf('@media (max-width: 560px)'), css.indexOf('/* ============================ Onboarding'));

test('the settings nav wraps at the minimum window instead of scrolling', () => {
  assert.match(compact, /\.s-nav \{[^}]*flex-wrap: wrap;/);
  assert.match(compact, /\.s-nav \{[^}]*overflow-x: visible;/);
  assert.doesNotMatch(compact, /\.s-nav \{[^}]*overflow-x: auto;/);
  assert.match(compact, /\.s-nav button \{[^}]*flex: 1 1 calc\(33\.333% - 4px\);/);
  assert.match(compact, /\.s-nav button \{[^}]*min-width: 0;/);
});

test('the settings harness proves it rather than trusting the document', () => {
  // The document never overflowed here: the nav scrolled inside its own box, which
  // is why the original assertion passed while 91px of tabs sat out of reach.
  assert.match(harness, /navOverflow: nav\.scrollWidth - nav\.clientWidth,/);
  assert.match(harness, /clippedTabs: tabs\.filter/);
  assert.match(harness, /assert\.equal\(compact\.navOverflow, 0,/);
  assert.match(harness, /assert\.equal\(compact\.clippedTabs, 0,/);
});
