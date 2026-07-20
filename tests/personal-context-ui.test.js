const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('Settings exposes local resume and job-description import, preview, enable, and removal controls', () => {
  for (const id of ['context-resume-enabled', 'context-jobDescription-enabled', 'context-resume-preview', 'context-jobDescription-preview', 'context-storage-status']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /PDF, DOCX, TXT, or Markdown/);
  assert.match(html, /5 MB maximum/);
  assert.match(renderer, /volyxLens\.personalContextImport\(kind\)/);
  assert.match(renderer, /volyxLens\.personalContextSetEnabled\(kind, event\.target\.checked\)/);
  assert.match(renderer, /window\.confirm/);
  assert.match(renderer, /preview\.textContent = documentState\.preview/);
});

test('personal-context IPC is narrow and file paths remain in the main process', () => {
  assert.match(preload, /personalContextImport: \(kind\) => ipcRenderer\.invoke\('personal-context:import', kind\)/);
  assert.doesNotMatch(preload, /personalContextImport: \([^)]*path/i);
  assert.match(main, /dialog\.showOpenDialog\(win/);
  assert.match(main, /parseContextDocument\(\{ filePath, buffer: await fs\.promises\.readFile\(filePath\) \}\)/);
  assert.match(main, /handleTrusted\('personal-context:remove'/);
});

test('answer generation discloses and safely injects only selected personal context', () => {
  assert.match(main, /buildPersonalContext\(personalContextStore\.getEnabledDocuments\(\)/);
  assert.match(main, /contextSources: personalContext\.sources/);
  assert.match(main, /const baseSystem = personalContext\.systemRules/);
  assert.match(main, /const system = `\$\{baseSystem\}\\n\\n\$\{UNTRUSTED_INPUT_RULE\}\\n\\n\$\{PLAIN_TEXT_OUTPUT_RULE\}`/);
  assert.match(renderer, /Personal context selected:/);
  assert.match(renderer, /Response provider:/);
  assert.match(renderer, /Fallback provider/);
});
