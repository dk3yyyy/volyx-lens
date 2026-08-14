const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { PROVIDERS, getDefaultSettings } = require('../src/provider-config');

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const rendererHtml = read(path.join('renderer', 'index.html'));
const rendererJs = read(path.join('renderer', 'renderer.js'));
const llmJs = read(path.join('src', 'llm.js'));
const storeJs = read(path.join('src', 'store.js'));
const readme = read('README.md');
const websiteHtml = read(path.join('website', 'index.html'));

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NATIVE_SDK_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'azure']);
// Docs and the landing page use the full brand name for Gemini.
const DOC_LABELS = { gemini: 'Google Gemini' };
const documentedLabel = (id, provider) => DOC_LABELS[id] || provider.label;

test('every provider defines a label, fast/smart model slots, and vision capability', () => {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    assert.ok(provider.label, `${id} needs a label`);
    assert.ok(provider.models && typeof provider.models.fast === 'string' && typeof provider.models.smart === 'string', `${id} needs fast/smart model slots`);
    assert.equal(typeof provider.supportsVision, 'boolean', `${id} needs supportsVision`);
  }
});

test('every provider has a routing path in llm.js (baseURL or explicit SDK branch)', () => {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    if (provider.baseURL) continue; // OpenAI-compatible branch in llm.js
    assert.ok(llmJs.includes(`resolved.provider === '${id}'`), `${id} has no baseURL and no llm.js routing branch`);
    assert.ok(NATIVE_SDK_PROVIDERS.has(id), `${id} uses a native SDK branch but is not in NATIVE_SDK_PROVIDERS`);
  }
});

test('default settings cover every provider key and model slot', () => {
  const defaults = getDefaultSettings();
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    assert.ok(Object.hasOwn(defaults.apiKeys, id), `${id} missing from default apiKeys`);
    assert.deepEqual(defaults.models[id], { fast: provider.models.fast, smart: provider.models.smart }, `${id} model defaults mismatch`);
  }
});

test('renderer exposes a tab, config row, and fallback option for every provider', () => {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    assert.match(rendererHtml, new RegExp(`data-provider="${id}"`), `${id} missing provider tab`);
    assert.match(rendererHtml, new RegExp(`data-provider-config="${id}"`), `${id} missing config row`);
    assert.match(rendererHtml, new RegExp(`<option value="${id}">${escapeRegex(provider.label)}</option>`), `${id} missing fallback option`);
  }
});

test('keyed providers get a key field; keyless providers get none', () => {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    if (provider.requiresKey !== false) {
      assert.match(rendererHtml, new RegExp(`id="key-${id}"`), `${id} missing key input`);
    } else {
      assert.doesNotMatch(rendererHtml, new RegExp(`id="key-${id}"`), `${id} should not have a key input`);
    }
  }
});

test('renderer labels and the capability note derive from provider metadata', () => {
  const labels = Object.entries(PROVIDERS).map(([id, provider]) => `${id}: '${provider.label}'`).join(', ');
  assert.ok(rendererJs.includes(`PROVIDER_LABELS = Object.freeze({ ${labels} })`), 'PROVIDER_LABELS is out of sync with PROVIDERS');
  assert.ok(storeJs.includes('providerCapabilities'), 'store does not expose providerCapabilities');
  assert.ok(rendererJs.includes('supportsVision !== false'), 'capability note must derive from supportsVision');
  assert.ok(!rendererJs.includes("['deepseek', 'groq']"), 'capability note must not hardcode a provider list');
});

test('README provider table and landing page provider list cover every provider', () => {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const label = documentedLabel(id, provider);
    assert.match(readme, new RegExp(`\\| \\*\\*${escapeRegex(label)}\\*\\* \\|`), `${id} missing from README provider table`);
    assert.match(websiteHtml, new RegExp(`>${escapeRegex(label)}<`), `${id} missing from landing page provider list`);
  }
});
