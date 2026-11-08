const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TIER_KEY_PROVIDERS } = require('../src/provider-config');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const settingsHarness = fs.readFileSync(path.join(root, 'scripts', 'check-settings-ui.js'), 'utf8');

test('settings use seven simple pages without removing existing controls', () => {
  for (const section of ['providers', 'listening', 'context', 'appearance', 'shortcuts', 'updates', 'help']) {
    assert.match(html, new RegExp(`data-settings-section="${section}"`));
    assert.match(html, new RegExp(`data-settings-page="${section}"`));
    assert.match(html, new RegExp(`id="settings-${section}-title"`));
  }
  assert.match(html, /id="settings"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(renderer, /function selectSettingsSection\(section/);
  assert.match(renderer, /page\.hidden = !active/);
  assert.match(styles, /grid-template-columns:\s*156px minmax\(0,1fr\)/);
});

test('the appearance pane exposes a native radio group and persists through the store', () => {
  assert.match(html, /data-settings-section="appearance" aria-controls="settings-page-appearance"/);
  assert.match(html, /id="settings-page-appearance"[^>]*data-settings-page="appearance"/);
  assert.match(html, /<fieldset class="s-theme-group">/);
  assert.match(html, /<legend>Accent theme<\/legend>/);
  for (const theme of ['indigo', 'sage', 'ember']) {
    assert.match(html, new RegExp(`name="accent-theme" value="${theme}"`));
  }
  assert.match(html, /value="sage" checked/);
  assert.match(html, /value="sage"[\s\S]*<small>Default[^<]*<\/small>/);
  assert.match(renderer, /settingsSet\(\{ appearance: \{ theme \} \}\)/);
  assert.match(renderer, /persistedTheme/);
  assert.match(renderer, /settings = \{ \.\.\.settings, appearance: \{ theme: saved \} \}/);
  assert.doesNotMatch(renderer, /settings = savedSettings;/);
  assert.match(renderer, /data-accent-theme/);
  assert.match(renderer, /localStorage\.setItem\('volyx\.accentTheme'/);
  assert.match(renderer, /restoreThemeRadio\.checked = true/);
  assert.match(styles, /\.s-theme-group/);
  assert.match(styles, /\.s-theme-swatch/);
});

test('settings behavior harness covers navigation, modal focus, and compact fit', () => {
  assert.equal(pkg.scripts['check:settings-ui'], 'electron scripts/check-settings-ui.js');
  assert.match(settingsHarness, /should be the only visible page/);
  assert.match(settingsHarness, /Shift\+Tab from heading should wrap/);
  assert.match(settingsHarness, /closing Settings should restore focus/);
  assert.match(settingsHarness, /compact Settings must not overflow horizontally/);
  assert.match(renderer, /function handleSettingsKeydown\(event\)/);
  // The ring moved from cyan to the accent family so a focused control and the
  // live-capture indicator are not the same colour (VR-36).
  assert.match(styles, /button:focus-visible[\s\S]*outline:\s*2px solid var\(--accent-soft\)/);
});

test('settings navigation is compact and interactive controls use restrained liquid-glass squircles', () => {
  assert.match(styles, /--r-control:\s*12px/);
  assert.match(styles, /\.s-layout\s*\{[^}]*grid-template-columns:\s*156px minmax\(0,1fr\)/);
  assert.match(styles, /\.s-nav button\s*\{[^}]*min-height:\s*40px[^}]*border-radius:\s*var\(--r-control\)/);
  assert.match(styles, /\.s-nav button\.on\s*\{[^}]*linear-gradient[^}]*inset 0 1px 0/);
  assert.match(styles, /\.s-seg button\s*\{[^}]*border-radius:\s*var\(--r-control\)/);
  assert.match(styles, /\.tb-new[^}]*border-radius:\s*var\(--r-control\)/);
});

test('settings and onboarding use compact click-through liquid-glass surfaces without a blocking backdrop', () => {
  assert.match(styles, /#settings-scrim\s*\{[^}]*background:\s*transparent[^}]*backdrop-filter:\s*none[^}]*pointer-events:\s*none/);
  assert.match(styles, /#onboard-scrim\s*\{[^}]*background:\s*transparent[^}]*backdrop-filter:\s*none[^}]*pointer-events:\s*none/);
  assert.match(styles, /#settings\s*\{[^}]*pointer-events:\s*auto[^}]*background:\s*rgba\([^)]*,\s*0\.7[0-9]\)/);
  assert.match(styles, /#onboard\s*\{[^}]*pointer-events:\s*auto[^}]*background:\s*rgba\([^)]*,\s*0\.7[0-9]\)/);
  assert.match(styles, /body:has\(#settings-scrim:not\(\.hidden\)\) #app,[\s\S]*body:has\(#onboard-scrim:not\(\.hidden\)\) #app\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
});

test('settings UI exposes clean provider tabs with one provider configuration at a time', () => {
  for (const provider of ['openai', 'anthropic', 'gemini', 'azure', 'deepseek', 'groq', 'openrouter', 'ollama', 'opencode', 'opencodeGo', 'custom']) {
    assert.match(html, new RegExp(`data-provider="${provider}"`));
    assert.match(html, new RegExp(`data-provider-config="${provider}"`));
  }
  for (const provider of ['openai', 'anthropic', 'gemini', 'azure', 'deepseek', 'groq', 'openrouter']) {
    assert.match(html, new RegExp(`id="key-${provider}"`));
  }
  assert.match(html, /data-provider-config="ollama"[\s\S]*localhost:11434/);
  assert.match(html, /id="endpoint-azure"/);
  assert.match(html, /id="endpoint-fast"/);
  assert.match(html, /id="endpoint-smart"/);
  assert.match(html, /id="key-fast"/);
  assert.match(html, /id="key-smart"/);
  assert.match(html, new RegExp(`data-tier-key-config="${TIER_KEY_PROVIDERS.join(' ')}"`), 'tier-key row must match TIER_KEY_PROVIDERS');
  assert.match(renderer, /row\.dataset\.providerConfig !== providerView/);
  assert.match(renderer, /data-endpoint-config/);
  assert.match(renderer, /data-tier-key-config/);
  assert.match(renderer, /settings\.endpointByTier\[providerView\]/);
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
  assert.match(renderer, /apiKeyUpdates\[`\$\{providerView\}\.\$\{tier\}`\] = value/);
  assert.match(renderer, /volyxLens\.clearCredential\(provider\)/);
  assert.match(renderer, /button\.dataset\.keyTier/);
  assert.doesNotMatch(renderer, /settings\.apiKeys\.[a-z]+\s*=/);
  assert.match(renderer, /settings\.endpoints\.azure/);
  assert.match(renderer, /function stashCurrentModels/);
});

test('cleared tier endpoints are stashed as empty strings, never by deleting the provider entry', () => {
  // The store deep-merges settings patches and cannot express deletion, so a
  // cleared endpoint override must be saved as an empty-string tier value
  // (which resolveProvider treats as unset). Deleting the provider entry lets
  // the previous override survive reload.
  assert.doesNotMatch(renderer, /delete settings\.endpointByTier\[providerView\]/);
  assert.match(renderer, /settings\.endpointByTier\[providerView\] = \{\s*fast: \$\('#endpoint-fast'\)\.value\.trim\(\),\s*smart: \$\('#endpoint-smart'\)\.value\.trim\(\),\s*\}/s);
  assert.doesNotMatch(renderer, /if \(fastEndpoint\) overrides\.fast/);
});

test('plaintext credential fallback surfaces a visible Settings warning', () => {
  assert.match(html, /id="s-storage-warning"[^>]*role="alert"/);
  assert.match(renderer, /s-storage-warning'\)\.classList\.toggle\('hidden', !\(storageState\.secure === false && storageState\.backend === 'plaintext-fallback'\)\)/);
  assert.match(styles, /\.s-warn/);
});

test('runtime fallback routing is visible and crosses only the existing event boundary', () => {
  assert.match(main, /createResponseRoute\(settings\)/);
  assert.match(main, /streamWithFallback/);
  assert.match(main, /fails? before producing text|failed before producing text/i);
  assert.match(main, /send\('llm:provider'/);
  assert.match(preload, /'llm:provider'/);
  assert.match(renderer, /Fallback provider/);
});

test('Help page reopens the interactive guide from Settings', () => {
  assert.match(html, /data-settings-section="help"/);
  assert.match(html, /data-settings-page="help"/);
  assert.match(html, /id="help-open-guide"[^>]*type="button"/);
  assert.match(html, /help-topics/);
  assert.match(renderer, /\$\('#help-open-guide'\)\.addEventListener\('click'/);
  assert.match(renderer, /showOnboard\(\{ full: true \}\)/);
  assert.match(styles, /\.help-actions button\s*\{[^}]*border-radius:\s*10px/);
  assert.match(styles, /\.help-topic-icon\s*\{[^}]*border-radius:\s*7px/);
});

test('local transcription disclosure states audio is never written to disk', () => {
  assert.match(html, /never written to disk and never leaves your computer/);
});

test('language field offers curated options and per-provider support disclosure', () => {
  assert.match(html, /id="stt-language"[^>]*list="stt-language-options"/);
  assert.match(html, /id="stt-language-options"/);
  assert.match(html, /<option value="fr">French<\/option>/);
  assert.match(html, /<option value="zh-TW">Chinese \(Traditional\)<\/option>/);
  assert.match(html, /Local whisper\.cpp supports 50\+ languages/);
  assert.match(html, /OpenAI and Gemini batch fallbacks auto-detect and ignore this field/);
});

test('settings never promise a saved key that is only in memory', () => {
  // Without a keyring the key is session-only (VR-22), so the field and the status
  // line have to say that rather than "saved securely" / "plaintext fallback".
  assert.match(renderer, /credentialStatus\.persisted === false \? 'Kept for this session — enter to replace'/);
  assert.match(renderer, /keys not saved \(session only\)/);
  assert.doesNotMatch(renderer, /: 'plaintext fallback'/);
  assert.match(html, /API keys are not saved on this system/);
  assert.doesNotMatch(html, /written to disk with restricted file permissions/);
});

test('provider tier keys are cleared before a provider switch can reuse them', () => {
  assert.match(renderer, /document\.querySelectorAll\('\[data-tier-key-config\]'\)[\s\S]{0,900}?input\.value = ''/);
  assert.match(renderer, /writing one provider's secret into another provider's slot/);
});

test('resetting shortcuts clears the local settings mirror before close saves', () => {
  assert.match(renderer, /settings\.shortcuts = \{\};[\s\S]{0,200}?renderShortcutStatus\(result\.status\)/);
});

test('long privacy notes are collapsed into disclosures instead of stacked paragraphs', () => {
  assert.match(html, /<details class="s-note-details"><summary>What leaves this device<\/summary>/);
  assert.match(html, /<details class="s-note-details"><summary>How offline transcription works<\/summary>/);
  assert.match(styles, /\.s-note-details[\s\S]*?\.s-note-details\[open\]/);
});

test('checkbox rows use a two-column grid and keyless custom providers are ready without a key', () => {
  assert.match(styles, /\.s-field:has\(input\[type="checkbox"\]\) \{[^}]*display: grid[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(renderer, /const customEndpoint = provider === 'custom'/);
  assert.match(renderer, /const keyless = provider === 'ollama' \|\| provider === 'opencode' \|\| customEndpoint/);
});

test('provider list treats stock model names as unconfigured unless the provider is keyless', () => {
  assert.match(renderer, /const keyless = id === 'ollama' \|\| id === 'opencode'/);
  assert.match(renderer, /present\[`\$\{id\}\.fast`\]/);
  assert.doesNotMatch(renderer, /const configured = new Set\(\[settings\.provider, settings\.fallbackProvider\]/);
});
