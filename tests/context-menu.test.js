'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { contextMenuTemplate, KINDS } = require('../src/context-menu');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

test('a text field gets the platform editing roles, so shortcuts are not the only route', () => {
  const template = contextMenuTemplate('editable');
  const roles = template.filter((item) => item.role).map((item) => item.role);
  assert.deepEqual(roles, ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  for (const item of template.filter((entry) => entry.role)) {
    assert.equal(item.id, undefined, 'a role item is performed by the platform, not the renderer');
    assert.ok(item.label, `${item.role} has a label`);
  }
});

test('a transcript turn offers copy and export, and disables what has nothing to copy', () => {
  const template = contextMenuTemplate('transcript-turn', { hasTurn: false, hasConversation: false });
  const byId = Object.fromEntries(template.filter((item) => item.id).map((item) => [item.id, item]));
  assert.equal(byId['copy-turn'].enabled, false, 'a turn with no text cannot be copied');
  assert.equal(byId['copy-conversation'].enabled, false);
  assert.equal(byId['export-transcript'].enabled, false);
  const enabled = contextMenuTemplate('transcript-turn');
  assert.ok(enabled.filter((item) => item.id).every((item) => item.enabled !== false));
});

test('a saved meeting row offers open, export and backup', () => {
  const ids = contextMenuTemplate('history-row').filter((item) => item.id).map((item) => item.id);
  assert.deepEqual(ids, ['open', 'export-md', 'backup-all']);
});

test('an unknown target gets no menu instead of a wrong one', () => {
  assert.deepEqual(contextMenuTemplate('something-else'), []);
  assert.deepEqual(contextMenuTemplate(''), []);
  assert.deepEqual(contextMenuTemplate(undefined), []);
  assert.equal(KINDS.size, 4);
});

test('menu ids are unique within a menu, so a click cannot be ambiguous', () => {
  for (const kind of KINDS) {
    const ids = contextMenuTemplate(kind).filter((item) => item.id).map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, `${kind} has unique ids`);
  }
});

test('an answer offers copy, and disables what has nothing to copy', () => {
  const template = contextMenuTemplate('answer');
  const ids = template.filter((item) => item.id).map((item) => item.id);
  assert.deepEqual(ids, ['copy-answer', 'copy-answer-and-question']);
  const disabled = Object.fromEntries(contextMenuTemplate('answer', { hasAnswer: false, hasQuestion: false }).filter((item) => item.id).map((item) => [item.id, item.enabled]));
  assert.equal(disabled['copy-answer'], false);
  assert.equal(disabled['copy-answer-and-question'], false);
  const noQuestion = Object.fromEntries(contextMenuTemplate('answer', { hasQuestion: false }).filter((item) => item.id).map((item) => [item.id, item.enabled]));
  assert.equal(noQuestion['copy-answer'], true, 'an answer with no question above it is still copyable');
  assert.equal(noQuestion['copy-answer-and-question'], false);
});

test('the answer is selectable and copyable through the app, not only in the menu', () => {
  const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
  // Every other content surface already re-enabled selection; the answer did not.
  assert.match(styles, /#messages \.ai-text \{[^}]*-webkit-user-select: text; user-select: text;/);
  assert.match(main, /handleTrusted\('text:copy'/);
  assert.match(main, /String\(text == null \? '' : text\)\.slice\(0, 200_000\)/, 'the copy is capped');
  assert.match(preload, /copyText: \(text\) => ipcRenderer\.invoke\('text:copy', text\)/);
  assert.match(renderer, /kind: 'answer'/);
  assert.match(renderer, /volyxLens\.copyText\(text\)/);
});

test('the menu is wired through the bridge and the main process', () => {
  assert.match(main, /require\('\.\/src\/context-menu'\)/);
  assert.match(main, /handleTrusted\('context-menu:show'/);
  assert.match(main, /Menu\.buildFromTemplate\(/);
  assert.match(main, /menu\.popup\(/);
  assert.match(preload, /showContextMenu: \(payload\) => ipcRenderer\.invoke\('context-menu:show', payload\)/);
  // The renderer routes right-click by target, and keeps the browser default out
  // of the way only when it has a menu to show.
  assert.match(renderer, /addEventListener\('contextmenu'/);
  assert.match(renderer, /kind: 'editable'/);
  assert.match(renderer, /kind: 'history-row'/);
  assert.match(renderer, /kind: 'transcript-turn'/);
});
