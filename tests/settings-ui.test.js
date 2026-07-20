const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const settingsHarness = fs.readFileSync(path.join(root, 'scripts', 'check-settings-ui.js'), 'utf8');

test('settings use four simple pages without removing existing controls', () => {
  for (const section of ['providers', 'listening', 'context', 'shortcuts']) {
    assert.match(html, new RegExp(`data-settings-section="${section}"`));
    assert.match(html, new RegExp(`data-settings-page="${section}"`));
    assert.match(html, new RegExp(`id="settings-${section}-title"`));
  }
  assert.match(html, /id="settings"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(renderer, /function selectSettingsSection\(section/);
  assert.match(renderer, /page\.hidden = !active/);
  assert.match(styles, /grid-template-columns:\s*156px minmax\(0,1fr\)/);
});

test('settings behavior harness covers navigation, modal focus, and compact fit', () => {
  assert.equal(pkg.scripts['check:settings-ui'], 'electron scripts/check-settings-ui.js');
  assert.match(settingsHarness, /should be the only visible page/);
  assert.match(settingsHarness, /Shift\+Tab from heading should wrap/);
  assert.match(settingsHarness, /closing Settings should restore focus/);
  assert.match(settingsHarness, /compact Settings must not overflow horizontally/);
  assert.match(renderer, /function handleSettingsKeydown\(event\)/);
  assert.match(styles, /button:focus-visible[\s\S]*outline:\s*2px solid var\(--cyan\)/);
});

test('settings UI exposes clean provider tabs with one provider configuration at a time', () => {
  for (const provider of ['openai', 'anthropic', 'gemini', 'azure', 'deepseek']) {
    assert.match(html, new RegExp(`data-provider="${provider}"`));
    assert.match(html, new RegExp(`data-provider-config="${provider}"`));
    assert.match(html, new RegExp(`id="key-${provider}"`));
  }
  assert.match(html, /id="endpoint-azure"/);
  assert.match(renderer, /row\.dataset\.providerConfig !== providerView/);
  assert.match(renderer, /providerView = button\.dataset\.provider/);
  assert.doesNotMatch(renderer, /settings\.provider = button\.dataset\.provider/);
  assert.equal(pkg.name, 'volyx-lens');
  assert.equal(pkg.build.productName, 'Volyx Lens');
});

test('default and optional fallback response providers are explicit and persisted separately', () => {
  assert.match(html, /id="provider-default-btn"/);
  assert.match(html, /id="provider-fallback"/);
  assert.match(renderer, /settings\.provider = providerView/);
  assert.match(renderer, /settings\.fallbackProvider = event\.target\.value/);
  assert.match(renderer, /fallback\.options/);
  assert.match(renderer, /\$\{fallbackLabel\} fallback/);
});

test('renderer loads credential presence and sends only explicit key updates', () => {
  assert.match(renderer, /settings\.credentialStatus/);
  assert.match(renderer, /apiKeyUpdates\[provider\] = value/);
  assert.match(renderer, /volyxLens\.clearCredential\(provider\)/);
  assert.doesNotMatch(renderer, /settings\.apiKeys\.[a-z]+\s*=/);
  assert.match(renderer, /settings\.endpoints\.azure/);
  assert.match(renderer, /function stashCurrentModels/);
});

test('runtime fallback routing is visible and crosses only the existing event boundary', () => {
  assert.match(main, /createResponseRoute\(settings\)/);
  assert.match(main, /streamWithFallback/);
  assert.match(main, /fails? before producing text|failed before producing text/i);
  assert.match(main, /send\('llm:provider'/);
  assert.match(preload, /'llm:provider'/);
  assert.match(renderer, /Fallback provider/);
});
