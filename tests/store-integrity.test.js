const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const storePath = require.resolve('../src/store');

function loadStore(userData, safeStorage = { isEncryptionAvailable: () => false }) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userData }, safeStorage };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[storePath];
  try { return require(storePath); }
  finally { Module._load = originalLoad; }
}

function temporaryUserData() { return fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-lens-store-test-')); }

test('partial nested settings patches preserve omitted preferences', () => {
  const store = loadStore(temporaryUserData());
  store.setSettings({
    provider: 'openai',
    fallbackProvider: 'anthropic',
    endpoints: { azure: 'https://one.openai.azure.com/openai/v1', azureRealtime: 'https://two.openai.azure.com/openai/v1' },
    models: { openai: { fast: 'fast-one', smart: 'smart-one' } },
    transcription: { mode: 'realtime', realtimeProvider: 'azure', language: 'en', delay: 'medium' },
    audio: { inputDeviceId: 'mic-one', micEnabled: false, systemEnabled: true, sensitivity: 'noisy', silenceMs: 700, preRollMs: 300, costWarningMinutes: 45, maxSessionMinutes: 90 },
  });

  const updated = store.setSettings({
    endpoints: { azure: 'https://updated.openai.azure.com/openai/v1' },
    models: { openai: { fast: 'fast-two' } },
    transcription: { language: 'fr' },
    audio: { silenceMs: 900 },
  });

  assert.equal(updated.endpoints.azureRealtime, 'https://two.openai.azure.com/openai/v1');
  assert.equal(updated.provider, 'openai');
  assert.equal(updated.fallbackProvider, 'anthropic');
  assert.deepEqual(updated.models.openai, { fast: 'fast-two', smart: 'smart-one' });
  assert.equal(updated.transcription.realtimeProvider, 'azure');
  assert.equal(updated.transcription.delay, 'medium');
  assert.equal(updated.transcription.language, 'fr');
  assert.equal(updated.audio.inputDeviceId, 'mic-one');
  assert.equal(updated.audio.micEnabled, false);
  assert.equal(updated.audio.systemEnabled, true);
  assert.equal(updated.audio.sensitivity, 'noisy');
  assert.equal(updated.audio.silenceMs, 900);
  assert.equal(updated.audio.maxSessionMinutes, 90);
});

test('legacy bundled model defaults migrate without replacing custom model names', () => {
  const userData = temporaryUserData();
  const file = path.join(userData, 'volyx-lens-data.json');
  fs.writeFileSync(file, JSON.stringify({
    models: {
      anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'my-private-claude-deployment' },
      gemini: { fast: 'gemini-1.5-flash', smart: 'gemini-1.5-pro' },
    },
  }));
  const settings = loadStore(userData).getSettings();
  assert.deepEqual(settings.models.anthropic, { fast: 'claude-haiku-4-5', smart: 'my-private-claude-deployment' });
  assert.deepEqual(settings.models.gemini, { fast: 'gemini-3.5-flash', smart: 'gemini-2.5-pro' });
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.models.anthropic.smart, 'my-private-claude-deployment');
  assert.equal(persisted.models.gemini.fast, 'gemini-3.5-flash');
});

test('response fallback cannot equal the default or use an unknown provider', () => {
  const store = loadStore(temporaryUserData());
  const same = store.setSettings({ provider: 'gemini', fallbackProvider: 'gemini' });
  assert.equal(same.provider, 'gemini');
  assert.equal(same.fallbackProvider, '');
  const unknown = store.setSettings({ fallbackProvider: 'unknown-provider' });
  assert.equal(unknown.fallbackProvider, '');
});

test('at least one audio channel remains enabled', () => {
  const store = loadStore(temporaryUserData());
  const updated = store.setSettings({ audio: { micEnabled: false, systemEnabled: false } });
  assert.equal(updated.audio.micEnabled, true);
  assert.equal(updated.audio.systemEnabled, false);

  const userData = temporaryUserData();
  fs.writeFileSync(path.join(userData, 'volyx-lens-data.json'), JSON.stringify({ audio: { micEnabled: false, systemEnabled: false } }));
  const loaded = loadStore(userData).getSettings();
  assert.equal(loaded.audio.micEnabled, true);
  assert.equal(loaded.audio.systemEnabled, false);
});

test('settings and credential updates commit in one atomic write and roll back together on failure', () => {
  const userData = temporaryUserData();
  const file = path.join(userData, 'volyx-lens-data.json');
  const store = loadStore(userData);
  store.updateSettingsAndApiKeys({ smart: false }, { openai: 'old-key' });
  const before = fs.readFileSync(file, 'utf8');

  const originalRename = fs.renameSync;
  let renames = 0;
  fs.renameSync = (...args) => { renames += 1; return originalRename(...args); };
  try {
    store.updateSettingsAndApiKeys({ smart: true }, { openai: 'new-key' });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(renames, 1);
  assert.equal(store.getSettings().smart, true);

  const committed = fs.readFileSync(file, 'utf8');
  const externallyHeldSettings = store.getSettings();
  const externallyHeldSnapshot = JSON.stringify(externallyHeldSettings);
  fs.renameSync = () => { throw new Error('simulated disk failure'); };
  try {
    assert.throws(() => store.updateSettingsAndApiKeys({ smart: false }, { openai: 'third-key' }), /could not be saved/i);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), committed);
  assert.equal(store.getSettings().smart, true);
  assert.equal(JSON.stringify(externallyHeldSettings), externallyHeldSnapshot);
  assert.notEqual(before, committed);
});

test('locked secure credentials cannot be overwritten by a partial key update', () => {
  const userData = temporaryUserData();
  const file = path.join(userData, 'volyx-lens-data.json');
  const lockedRecord = { version: 1, mode: 'safeStorage', values: { openai: 'opaque-one', azure: 'opaque-two' } };
  fs.writeFileSync(file, JSON.stringify({ smart: false, credentials: lockedRecord }));
  const store = loadStore(userData);

  const status = store.getPublicSettings().credentialStatus;
  assert.equal(status.backend, 'locked-safeStorage');
  assert.equal(status.present.openai, true);
  assert.throws(() => store.updateApiKeys({ deepseek: 'replacement' }), /locked by the operating system/i);

  store.setSettings({ smart: true });
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(persisted.credentials, lockedRecord);
  assert.equal(persisted.smart, true);
});

test('partially decryptable credentials from an incompatible app identity remain locked and are never overwritten', () => {
  const userData = temporaryUserData();
  const file = path.join(userData, 'volyx-lens-data.json');
  const lockedRecord = { version: 1, mode: 'safeStorage', values: {
    openai: Buffer.from('compatible').toString('base64'),
    azure: Buffer.from('old-app-ciphertext').toString('base64'),
  } };
  fs.writeFileSync(file, JSON.stringify({ credentials: lockedRecord }));
  const incompatibleStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => {
      if (value.toString() === 'compatible') return 'still-readable-key';
      throw new Error('wrong application identity');
    },
  };
  const store = loadStore(userData, incompatibleStorage);
  const status = store.getPublicSettings().credentialStatus;
  assert.equal(status.backend, 'locked-safeStorage');
  assert.equal(status.present.openai, true);
  assert.equal(status.present.azure, true);
  store.setSettings({ smart: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).credentials, lockedRecord);
  assert.throws(() => store.updateApiKeys({ deepseek: 'must-not-reseal' }), /locked by the operating system/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).credentials, lockedRecord);
});
