const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const diagnostic = fs.readFileSync(path.join(root, 'src', 'response-diagnostic.js'), 'utf8');

test('Settings discloses and explicitly triggers a minimal response-provider test', () => {
  assert.match(html, /id="provider-test-tier"/);
  assert.match(html, /id="provider-test-btn"[^>]*>Test connection<\/button>/);
  assert.match(html, /one minimal text-only request/);
  assert.match(html, /never includes screenshots, transcript, or personal context/);
  assert.match(html, /small provider charge may apply/);
  assert.match(html, /id="provider-test-result"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(renderer, /await saveSettings\(\);\n\s*const result = await volyxLens\.testResponseProvider\(testedProvider, testedTier\)/);
  assert.match(renderer, /resultEl\.textContent =/);
  assert.match(renderer, /providerTestActive = true/);
  assert.match(renderer, /Wait for the response-provider test to finish/);
});

test('response-provider diagnostic crosses a narrow structured IPC boundary', () => {
  assert.match(preload, /testResponseProvider: \(provider, tier\) => ipcRenderer\.invoke\('provider:test-response', \{ provider, tier \}\)/);
  assert.match(main, /ipcMain\.handle\('provider:test-response'/);
  assert.match(main, /runResponseDiagnostic\(\{/);
  assert.match(main, /if \(responseDiagnosticPromise\)/);
  assert.match(diagnostic, /fallbackProvider = ''/);
  assert.match(diagnostic, /imageDataUrl: null/);
  assert.match(diagnostic, /imageDataUrls: \[\]/);
  assert.match(diagnostic, /maxTokens: MAX_OUTPUT_TOKENS/);
  assert.doesNotMatch(renderer, /testResponseProvider\([^)]*(apiKey|endpoint|transcript|personalContext|image)/);
});

test('diagnostic results display model tier, route, vision support, and latency without HTML injection', () => {
  assert.match(renderer, /Fast:|`\$\{tierLabel\}: \$\{result\.model/);
  assert.match(renderer, /providerRouteLabel\(result\.route\)/);
  assert.match(renderer, /result\.supportsVision \? 'vision capable' : 'text only'/);
  assert.match(renderer, /`\$\{result\.latencyMs\} ms`/);
  assert.doesNotMatch(renderer, /provider-test-result[\s\S]{0,500}innerHTML/);
});
