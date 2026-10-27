'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

function declarations() {
  const found = [];
  // Both ways a size can be declared: `font-size: Npx` and the `font:` shorthand.
  // The shorthand is how four controls kept an 8-9px size after the first pass.
  for (const pattern of [/font-size:\s*([0-9.]+)px/g, /font:\s*[0-9]+\s+([0-9.]+)px/g]) {
    let match;
    while ((match = pattern.exec(css)) !== null) {
      const brace = css.lastIndexOf('{', match.index);
      const previous = Math.max(css.lastIndexOf('}', brace), css.lastIndexOf('{', brace - 1));
      const selector = css.slice(previous + 1, brace).trim();
      found.push({ size: Number(match[1]), selector });
    }
  }
  return found;
}

test('no readable text is set below 10px', () => {
  const small = declarations().filter((entry) => entry.size < 10);
  assert.deepEqual(
    small.map((entry) => `${entry.selector} ${entry.size}px`),
    [],
    'a 7.5-9.5px tier carried timestamps, history previews, task-context labels and slide rows',
  );
});

test('controls are set at 11px or larger', () => {
  // Selectors that end in a button are the things the user clicks; a `<small>`
  // inside a button is still body copy and only has to clear 10px.
  const controls = declarations().filter((entry) => /button$/.test(entry.selector.trim()));
  assert.ok(controls.length > 0, 'the file still declares button type');
  const small = controls.filter((entry) => entry.size < 11);
  assert.deepEqual(small.map((entry) => `${entry.selector} ${entry.size}px`), []);
});

test('the sizes the review called out are where it asked for them', () => {
  const bySelector = new Map(declarations().map((entry) => [entry.selector, entry.size]));
  assert.equal(bySelector.get('.transcript-time'), 10.5, 'transcript timestamps');
  assert.equal(bySelector.get('.history-turn .history-time'), 10.5, 'history turn timestamps');
  assert.equal(bySelector.get('.history-entry-open span'), 10, 'history previews');
  assert.equal(bySelector.get('#task-context-page-label'), 10, 'task-context page label');
  assert.equal(bySelector.get('.s-nav span'), 10.5, 'settings nav subtitles');
  assert.equal(bySelector.get('#transcript-count'), 11, 'transcript count');
});

test('the font shorthand does not smuggle a size below the floor either', () => {
  const shorthand = [];
  const pattern = /font:\s*[0-9]+\s+([0-9.]+)px/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    const brace = css.lastIndexOf('{', match.index);
    const previous = Math.max(css.lastIndexOf('}', brace), css.lastIndexOf('{', brace - 1));
    shorthand.push({ size: Number(match[1]), selector: css.slice(previous + 1, brace).trim() });
  }
  assert.ok(shorthand.length > 0, 'the stylesheet still uses the shorthand');
  assert.deepEqual(
    shorthand.filter((entry) => entry.size < 10).map((entry) => `${entry.selector} ${entry.size}px`),
    [],
  );
});
