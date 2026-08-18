const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const registry = fs.readFileSync(path.join(root, 'src', 'shortcut-registry.js'), 'utf8');

test('renderer maps every mac glyph shortcut to its Windows Ctrl label', () => {
  assert.match(renderer, /⌘↵': 'Ctrl\+Enter'/);
  assert.match(renderer, /⌘H': 'Ctrl\+H'/);
  assert.match(renderer, /⌘⇧C': 'Ctrl\+Shift\+C'/);
  assert.match(renderer, /⌘⇧X': 'Ctrl\+Shift\+X'/);
});

test('renderer exposes a shortcut localization helper guarded to non-darwin', () => {
  assert.match(renderer, /function localizeShortcutText\(text\)/);
  assert.match(renderer, /volyxLens\.platform === 'darwin'/);
  assert.match(renderer, /function localizeKeyLabels\(\)/);
  assert.match(renderer, /localizeShortcutText\(step\.body\)/);
});

test('onboarding and keycap DOM elements are addressable for relabeling', () => {
  assert.match(html, /id="composer-mod-key"/);
  assert.match(html, /id="composer-enter-key"/);
  assert.match(html, /id="task-context-capture-kbd"/);
  assert.match(renderer, /querySelectorAll\('\.help-topic-icon'\)/);
});

test('renderer relabels the composer, task-context, help, and shortcut-status surfaces on Windows', () => {
  assert.match(renderer, /composer-mod-key/);
  assert.match(renderer, /composer-enter-key/);
  assert.match(renderer, /task-context-capture-kbd/);
  assert.match(renderer, /task-context-capture/);
  assert.match(renderer, /querySelectorAll\('\.shortcut-status-row kbd'\)/);
});

test('key handling uses the platform modifier key so Ctrl works on Windows', () => {
  assert.match(renderer, /const primary = volyxLens\.platform === 'darwin' \? e\.metaKey : e\.ctrlKey;/);
  assert.match(renderer, /volyxLens\.platform === 'darwin' \? e\.metaKey : e\.ctrlKey\) && e\.key === ','/);
});

test('onboarding copy is platform-neutral outside darwin-only capture details', () => {
  assert.doesNotMatch(renderer, /happening on your Mac/);
  assert.doesNotMatch(renderer, /loopback on macOS/);
  assert.doesNotMatch(renderer, /asks macOS to exclude/);
});

test('shortcut registry message is operating-system neutral', () => {
  assert.doesNotMatch(registry, /macOS, the operating system/);
  assert.match(registry, /the operating system or another application may own/);
});