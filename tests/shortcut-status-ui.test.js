const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('Settings reports all fixed global shortcuts with explicit in-app fallbacks', () => {
  for (const id of ['assist', 'solve', 'task-context', 'quit']) {
    assert.match(html, new RegExp(`data-shortcut="${id}"`));
    assert.match(html, new RegExp(`data-shortcut-fallback="${id}"`));
  }
  assert.match(html, /id="shortcuts-retry"[^>]*>Retry unavailable<\/button>/);
  assert.match(html, /Global registration is checked at launch/);
  assert.match(html, /Unavailable features remain accessible through these buttons/);
});

test('shortcut status and retry use narrow IPC and sanitized structured metadata', () => {
  assert.match(preload, /shortcutsGet: \(\) => ipcRenderer\.invoke\('shortcuts:get'\)/);
  assert.match(preload, /shortcutsRetry: \(\) => ipcRenderer\.invoke\('shortcuts:retry'\)/);
  assert.match(main, /ipcMain\.handle\('shortcuts:get', \(\) => getShortcutStatus\(\)\)/);
  assert.match(main, /ipcMain\.handle\('shortcuts:retry', \(\) => registerShortcuts\(\)\)/);
  assert.match(main, /shortcuts: getShortcutStatus\(\)/);
  assert.match(renderer, /row\.querySelector\('span'\)\.textContent/);
  assert.doesNotMatch(renderer, /shortcut-status-row[\s\S]{0,500}innerHTML/);
});

test('shortcut fallbacks preserve Assist, Solve, Add screen, and emergency quit actions', () => {
  assert.match(renderer, /if \(action === 'assist'\) runMode\('assist', ''\)/);
  assert.match(renderer, /else if \(action === 'solve'\) runMode\('leetcode', ''\)/);
  assert.match(renderer, /else if \(action === 'task-context'\) await captureTaskContext\(\)/);
  assert.match(renderer, /if \(action === 'quit'\) \{ volyxLens\.quit\(\); return; \}/);
  assert.match(main, /id: 'assist',[^\n]*accelerator: 'CommandOrControl\+Return'/);
  assert.match(main, /id: 'solve',[^\n]*accelerator: 'CommandOrControl\+H'/);
  assert.match(main, /id: 'task-context',[^\n]*accelerator: 'CommandOrControl\+Shift\+C'/);
  assert.match(main, /id: 'quit',[^\n]*accelerator: 'CommandOrControl\+Shift\+X'/);
});
