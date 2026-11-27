'use strict';

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
      return {
        app: { getPath: () => userData, isReady: () => true },
        safeStorage: { isEncryptionAvailable: () => false },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[storePath];
  try { return require(storePath); }
  finally { Module._load = originalLoad; }
}

function temporaryUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-diar-settings-'));
}

test('diarization is off by default with a bounded offline preset', () => {
  const store = loadStore(temporaryUserData());
  assert.deepEqual(store.getSettings().transcription.diarization, {
    enabled: false,
    preset: 'very_high_latency',
    maxMinutes: 5,
  });
});

test('diarization patches are normalized before they reach the recorder', () => {
  const store = loadStore(temporaryUserData());
  let updated = store.setSettings({
    transcription: { diarization: { enabled: true, preset: 'low_latency', maxMinutes: 99 } },
  });
  assert.deepEqual(updated.transcription.diarization, { enabled: true, preset: 'low_latency', maxMinutes: 10 });

  updated = store.setSettings({ transcription: { diarization: { maxMinutes: 0 } } });
  assert.deepEqual(updated.transcription.diarization, { enabled: false, preset: 'very_high_latency', maxMinutes: 1 });

  updated = store.setSettings({ transcription: { diarization: { enabled: true, preset: 'turbo', maxMinutes: 3.9 } } });
  assert.deepEqual(updated.transcription.diarization, { enabled: true, preset: 'very_high_latency', maxMinutes: 3 });

  updated = store.setSettings({ transcription: { diarization: { enabled: 'yes', maxMinutes: 'lots' } } });
  assert.deepEqual(updated.transcription.diarization, { enabled: false, preset: 'very_high_latency', maxMinutes: 5 });
});

test('a hand-edited settings file cannot widen diarization retention', () => {
  const userData = temporaryUserData();
  fs.writeFileSync(path.join(userData, 'volyx-lens-data.json'), JSON.stringify({
    transcription: {
      historyEnabled: true,
      diarization: { enabled: true, preset: 'not-a-preset', maxMinutes: 600 },
    },
  }));
  const store = loadStore(userData);
  assert.deepEqual(store.getSettings().transcription.diarization, {
    enabled: true,
    preset: 'very_high_latency',
    maxMinutes: 10,
  });
});

test('diarization settings survive an atomic reload', () => {
  const userData = temporaryUserData();
  const store = loadStore(userData);
  store.setSettings({
    transcription: { diarization: { enabled: true, preset: 'high_latency', maxMinutes: 7 } },
  });
  const reloaded = loadStore(userData);
  assert.deepEqual(reloaded.getSettings().transcription.diarization, {
    enabled: true,
    preset: 'high_latency',
    maxMinutes: 7,
  });
});
