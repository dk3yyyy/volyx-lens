const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const storePath = require.resolve('../src/store');

function loadStore(userData) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => userData }, safeStorage: { isEncryptionAvailable: () => false } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[storePath];
  try {
    return require(storePath);
  } finally {
    Module._load = originalLoad;
  }
}

function temporaryUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-lens-appearance-test-'));
}

function writeData(userData, value) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'volyx-lens-data.json'), JSON.stringify(value, null, 2));
}

function readData(userData) {
  return JSON.parse(fs.readFileSync(path.join(userData, 'volyx-lens-data.json'), 'utf8'));
}

const { ACCENT_THEMES, DEFAULT_ACCENT_THEME } = require('../src/appearance-themes');

test('the default settings expose indigo as the only initial accent', () => {
  assert.deepEqual([...ACCENT_THEMES], ['indigo', 'sage', 'ember']);
  assert.equal(DEFAULT_ACCENT_THEME, 'indigo');
  const store = loadStore(temporaryUserData());
  assert.deepEqual(store.getSettings().appearance, { theme: 'indigo' });
  assert.deepEqual(store.getPublicSettings().appearance, { theme: 'indigo' });
});

test('a valid accent theme round-trips through the store', () => {
  const userData = temporaryUserData();
  const store = loadStore(userData);
  store.setSettings({ appearance: { theme: 'sage' } });
  assert.equal(store.getSettings().appearance.theme, 'sage');
  assert.equal(readData(userData).appearance.theme, 'sage');
  assert.equal(loadStore(userData).getSettings().appearance.theme, 'sage');
});

test('partial and unrelated patches preserve the stored theme', () => {
  const userData = temporaryUserData();
  const store = loadStore(userData);
  store.setSettings({ appearance: { theme: 'ember' } });
  store.setSettings({ appearance: {} });
  assert.equal(store.getSettings().appearance.theme, 'ember');
  store.setSettings({ provider: 'anthropic' });
  assert.equal(store.getSettings().appearance.theme, 'ember');
});

test('unknown, wrong-case, and non-string values are ignored', () => {
  const invalid = ['neon', 'Indigo', ' indigo ', '', 1, true, null, ['sage'], { theme: 'sage' }];
  for (const value of invalid) {
    const store = loadStore(temporaryUserData());
    store.setSettings({ appearance: { theme: 'sage' } });
    store.setSettings({ appearance: { theme: value } });
    assert.equal(store.getSettings().appearance.theme, 'sage', `rejects ${JSON.stringify(value)}`);
  }
});

test('prototype pollution cannot create or change the theme', () => {
  const store = loadStore(temporaryUserData());
  const patch = JSON.parse('{"appearance":{"__proto__":{"theme":"ember"}}}');
  store.setSettings(patch);
  assert.equal(store.getSettings().appearance.theme, 'indigo');
  assert.equal({}.theme, undefined);
});

test('a corrupt persisted theme loads as indigo and self-heals on save', () => {
  const userData = temporaryUserData();
  writeData(userData, { appearance: { theme: 'chartreuse' } });
  const store = loadStore(userData);
  assert.equal(store.getSettings().appearance.theme, 'indigo');
  store.setSettings({ provider: 'openai' });
  assert.equal(readData(userData).appearance.theme, 'indigo');
});

test('corrupt persisted shapes cannot reach the renderer', () => {
  for (const value of [{ appearance: 'ember' }, { appearance: null }, { appearance: { theme: 42 } }, { appearance: [] }]) {
    const userData = temporaryUserData();
    writeData(userData, value);
    const store = loadStore(userData);
    assert.deepEqual(store.getPublicSettings().appearance, { theme: 'indigo' }, JSON.stringify(value));
  }
});

test('a missing appearance key migrates silently to indigo', () => {
  const userData = temporaryUserData();
  writeData(userData, { provider: 'openai' });
  const store = loadStore(userData);
  assert.deepEqual(store.getSettings().appearance, { theme: 'indigo' });
});

test('a null settings root cannot crash startup', () => {
  const userData = temporaryUserData();
  writeData(userData, null);
  const store = loadStore(userData);
  assert.deepEqual(store.getSettings().appearance, { theme: 'indigo' });
  assert.equal(store.getSettings().provider, 'openai');
});

test('unknown appearance subkeys are stripped from the public projection', () => {
  const store = loadStore(temporaryUserData());
  store.setSettings({ appearance: { theme: 'sage', css: 'body{}' } });
  assert.deepEqual(store.getPublicSettings().appearance, { theme: 'sage' });
});

test('the sanitizer accepts only the three ids', () => {
  const store = loadStore(temporaryUserData());
  for (const theme of ACCENT_THEMES) {
    assert.deepEqual(store.sanitizeSettingsPatch({ appearance: { theme } }), { appearance: { theme } });
  }
  assert.deepEqual(store.sanitizeSettingsPatch({ appearance: { theme: 'neon' } }), {});
  assert.deepEqual(store.sanitizeSettingsPatch({ appearance: { theme: 'indigo', css: 'x' } }), { appearance: { theme: 'indigo' } });
});
