const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');

test('all generated-answer actions expose an immediate compact processing indicator', () => {
  assert.match(html, /class="act assist-act"[^>]*data-mode="assist"/);
  assert.match(html, /class="assist-label">Assist<\/span>/);
  for (const [mode, label] of [
    ['say', 'What should I say?'],
    ['followup', 'Follow-up questions'],
    ['recap', 'Recap'],
  ]) {
    assert.match(html, new RegExp(`data-mode="${mode}"[^>]*[\\s\\S]*?class="action-label">${label.replace('?', '\\?')}<\\/span>[\\s\\S]*?class="assist-loader"`));
  }
  assert.equal((html.match(/class="assist-loader"[^>]*><i><\/i><i><\/i><i><\/i>/g) || []).length, 4);
  assert.match(renderer, /setBusy\(true, mode\)/);
  assert.match(renderer, /processingButtonMode = isAssistMode\(activeRequestMode\) \? 'assist' : activeRequestMode/);
  assert.match(renderer, /button\.classList\.toggle\('processing', processing\)/);
  assert.match(renderer, /label\.textContent = processing \? 'Working' : ACTION_LABELS\[buttonMode\]/);
  assert.match(renderer, /document\.querySelectorAll\('\.act\[data-mode\]'\)[\s\S]*button\.disabled = value/);
  assert.match(html, /id="task-context-toggle"[^>]*class="act"|class="act"[^>]*id="task-context-toggle"/);
  assert.match(renderer, /setAttribute\('aria-busy', String\(processing\)\)/);
  assert.match(styles, /\.act\.processing \.assist-loader \{ display: inline-flex; \}/);
  assert.match(styles, /@keyframes assist-dot-pulse/);
});

test('action processing state clears on completion, error, or session reset', () => {
  assert.match(renderer, /volyxLens\.on\('llm:done',[\s\S]*setBusy\(false\)/);
  assert.match(renderer, /volyxLens\.on\('llm:error',[\s\S]*setBusy\(false\)/);
  assert.match(renderer, /volyxLens\.on\('session:cleared',[\s\S]*setBusy\(false\)/);
});
