// JSON settings plus main-process credential protection through Electron safeStorage.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { getDefaultSettings } = require('./provider-config');
const { createCredentialVault } = require('./credential-vault');

const FILE = path.join(app.getPath('userData'), 'volyx-lens-data.json');
const DEFAULTS = getDefaultSettings();
const vault = createCredentialVault(safeStorage);
const KEY_NAMES = Object.freeze(Object.keys(DEFAULTS.apiKeys));
const LEGACY_MODEL_DEFAULTS = Object.freeze({
  anthropic: Object.freeze({
    'claude-3-5-haiku-latest': 'claude-haiku-4-5',
    'claude-3-5-sonnet-latest': 'claude-sonnet-5',
  }),
  gemini: Object.freeze({
    'gemini-1.5-flash': 'gemini-3.5-flash',
    'gemini-1.5-pro': 'gemini-2.5-pro',
  }),
});
let data = null;
let persistedCredentialRecord = null;
let credentialRecordLocked = false;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(over || {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    if (over[key] && typeof over[key] === 'object' && !Array.isArray(over[key]) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], over[key]);
    } else {
      out[key] = over[key];
    }
  }
  return out;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function migrateLegacyModelDefaults(settings) {
  let changed = false;
  for (const [provider, replacements] of Object.entries(LEGACY_MODEL_DEFAULTS)) {
    const models = settings.models && settings.models[provider];
    if (!models) continue;
    for (const tier of ['fast', 'smart']) {
      if (!Object.hasOwn(replacements, models[tier])) continue;
      models[tier] = replacements[models[tier]];
      changed = true;
    }
  }
  return changed;
}

function load() {
  if (data) return data;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const legacyKeys = raw.apiKeys && typeof raw.apiKeys === 'object' ? raw.apiKeys : {};
  persistedCredentialRecord = raw.credentials && typeof raw.credentials === 'object' ? raw.credentials : null;
  const openedCredentials = vault.openWithStatus(persistedCredentialRecord);
  credentialRecordLocked = !!(persistedCredentialRecord && persistedCredentialRecord.mode === 'safeStorage'
    && (!vault.isSecure() || openedCredentials.failedNames.length));
  const protectedKeys = openedCredentials.values;
  const settingsOnly = { ...raw };
  delete settingsOnly.credentials;
  delete settingsOnly.credentialStatus;
  delete settingsOnly.apiKeyUpdates;
  delete settingsOnly.apiKeys;
  data = deepMerge(DEFAULTS, settingsOnly);
  const migratedModelDefaults = migrateLegacyModelDefaults(data);
  if (data.fallbackProvider === data.provider || (data.fallbackProvider !== '' && !Object.hasOwn(DEFAULTS.models, data.fallbackProvider))) data.fallbackProvider = '';
  if (!data.audio.micEnabled && !data.audio.systemEnabled) data.audio.micEnabled = true;
  data.apiKeys = { ...DEFAULTS.apiKeys, ...protectedKeys };
  for (const name of KEY_NAMES) {
    if (legacyKeys[name]) data.apiKeys[name] = String(legacyKeys[name]);
  }
  if (Object.values(legacyKeys).some(Boolean) || migratedModelDefaults) save();
  return data;
}

function save() {
  if (!data) return;
  const serialized = clone(data);
  delete serialized.apiKeys;
  delete serialized.credentialStatus;
  serialized.credentials = credentialRecordLocked && persistedCredentialRecord
    ? persistedCredentialRecord
    : vault.seal(data.apiKeys);
  const nextCredentialRecord = serialized.credentials;
  const nextCredentialLocked = credentialRecordLocked
    || (nextCredentialRecord.mode === 'safeStorage' && !vault.isSecure());
  const temporary = `${FILE}.tmp`;
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fd = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify(serialized, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, FILE);
    try { fs.chmodSync(FILE, 0o600); } catch {}
    persistedCredentialRecord = nextCredentialRecord;
    credentialRecordLocked = nextCredentialLocked;
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    console.log('[store] settings save failed', error && error.code ? error.code : 'unknown');
    throw new Error('Settings could not be saved to disk. Check available storage and file permissions.');
  }
}

function publicSettings() {
  const full = load();
  const result = clone(full);
  result.apiKeys = Object.fromEntries(KEY_NAMES.map((name) => [name, '']));
  const persistedNames = (persistedCredentialRecord && persistedCredentialRecord.values) || {};
  result.credentialStatus = {
    present: Object.fromEntries(KEY_NAMES.map((name) => [name, !!full.apiKeys[name] || !!persistedNames[name]])),
    secure: vault.isSecure() && !credentialRecordLocked,
    backend: credentialRecordLocked ? 'locked-safeStorage' : vault.backend(),
  };
  return result;
}

function sanitizeSettingsPatch(patch = {}) {
  const safe = {};
  if (typeof patch.provider === 'string' && Object.hasOwn(DEFAULTS.models, patch.provider)) safe.provider = patch.provider;
  if (typeof patch.fallbackProvider === 'string' && (patch.fallbackProvider === '' || Object.hasOwn(DEFAULTS.models, patch.fallbackProvider))) safe.fallbackProvider = patch.fallbackProvider;
  if (typeof patch.smart === 'boolean') safe.smart = patch.smart;
  if (typeof patch.questionDetection === 'boolean') safe.questionDetection = patch.questionDetection;
  if (typeof patch.onboarded === 'boolean') safe.onboarded = patch.onboarded;
  if (['both', 'screen', 'conversation'].includes(patch.assistContext)) safe.assistContext = patch.assistContext;
  if (patch.endpoints && typeof patch.endpoints === 'object') {
    const endpoints = {};
    if (Object.hasOwn(patch.endpoints, 'azure') && typeof patch.endpoints.azure === 'string') endpoints.azure = patch.endpoints.azure.slice(0, 2048);
    if (Object.hasOwn(patch.endpoints, 'azureRealtime') && typeof patch.endpoints.azureRealtime === 'string') endpoints.azureRealtime = patch.endpoints.azureRealtime.slice(0, 2048);
    if (Object.keys(endpoints).length) safe.endpoints = endpoints;
  }
  if (patch.models && typeof patch.models === 'object') {
    const models = {};
    for (const provider of Object.keys(DEFAULTS.models)) {
      const supplied = patch.models[provider];
      if (!supplied || typeof supplied !== 'object') continue;
      const modelPatch = {};
      if (Object.hasOwn(supplied, 'fast')) modelPatch.fast = String(supplied.fast || '').slice(0, 200);
      if (Object.hasOwn(supplied, 'smart')) modelPatch.smart = String(supplied.smart || '').slice(0, 200);
      if (Object.keys(modelPatch).length) models[provider] = modelPatch;
    }
    if (Object.keys(models).length) safe.models = models;
  }
  if (patch.transcription && typeof patch.transcription === 'object') {
    const value = patch.transcription;
    const transcription = {};
    if (Object.hasOwn(value, 'mode') && ['realtime', 'batch'].includes(value.mode)) transcription.mode = value.mode;
    if (Object.hasOwn(value, 'realtimeProvider') && ['openai', 'azure', 'deepgram'].includes(value.realtimeProvider)) transcription.realtimeProvider = value.realtimeProvider;
    if (Object.hasOwn(value, 'realtimeModel')) transcription.realtimeModel = String(value.realtimeModel || DEFAULTS.transcription.realtimeModel).slice(0, 200);
    if (Object.hasOwn(value, 'deepgramModel')) transcription.deepgramModel = String(value.deepgramModel || DEFAULTS.transcription.deepgramModel).slice(0, 200);
    if (Object.hasOwn(value, 'azureRealtimeDeployment')) transcription.azureRealtimeDeployment = String(value.azureRealtimeDeployment || '').slice(0, 200);
    if (Object.hasOwn(value, 'fallbackModel')) transcription.fallbackModel = String(value.fallbackModel || DEFAULTS.transcription.fallbackModel).slice(0, 200);
    if (Object.hasOwn(value, 'geminiFallbackModel')) transcription.geminiFallbackModel = String(value.geminiFallbackModel || DEFAULTS.transcription.geminiFallbackModel).slice(0, 200);
    if (Object.hasOwn(value, 'offlineEnabled') && typeof value.offlineEnabled === 'boolean') transcription.offlineEnabled = value.offlineEnabled;
    if (Object.hasOwn(value, 'offlineCloudFallback') && typeof value.offlineCloudFallback === 'boolean') transcription.offlineCloudFallback = value.offlineCloudFallback;
    if (Object.hasOwn(value, 'language')) transcription.language = String(value.language || '').slice(0, 20);
    if (Object.hasOwn(value, 'delay') && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value.delay)) transcription.delay = value.delay;
    if (Object.keys(transcription).length) safe.transcription = transcription;
  }
  if (patch.audio && typeof patch.audio === 'object') {
    const value = patch.audio;
    const audio = {};
    if (Object.hasOwn(value, 'inputDeviceId')) audio.inputDeviceId = String(value.inputDeviceId || '').slice(0, 500);
    if (Object.hasOwn(value, 'micEnabled') && typeof value.micEnabled === 'boolean') audio.micEnabled = value.micEnabled;
    if (Object.hasOwn(value, 'systemEnabled') && typeof value.systemEnabled === 'boolean') audio.systemEnabled = value.systemEnabled;
    if (Object.hasOwn(value, 'sensitivity') && ['quiet', 'balanced', 'noisy'].includes(value.sensitivity)) audio.sensitivity = value.sensitivity;
    if (Object.hasOwn(value, 'silenceMs')) audio.silenceMs = Math.max(300, Math.min(2000, Number(value.silenceMs) || 700));
    if (Object.hasOwn(value, 'preRollMs')) audio.preRollMs = Math.max(0, Math.min(1000, Number(value.preRollMs) || 250));
    if (Object.hasOwn(value, 'costWarningMinutes')) audio.costWarningMinutes = Math.max(5, Math.min(240, Number(value.costWarningMinutes) || 30));
    if (Object.hasOwn(value, 'maxSessionMinutes')) audio.maxSessionMinutes = Math.max(10, Math.min(480, Number(value.maxSessionMinutes) || 60));
    if (Object.keys(audio).length) safe.audio = audio;
  }
  return safe;
}

function setSettings(patch) {
  load();
  const previous = data;
  data = clone(data);
  try {
    data = deepMerge(data, sanitizeSettingsPatch(patch));
    if (data.fallbackProvider === data.provider) data.fallbackProvider = '';
    if (!data.audio.micEnabled && !data.audio.systemEnabled) data.audio.micEnabled = true;
    save();
  } catch (error) {
    data = previous;
    throw error;
  }
  return data;
}

function applyApiKeyUpdates(updates) {
  const accepted = Object.entries(updates || {}).filter(([name]) => KEY_NAMES.includes(name));
  if (credentialRecordLocked && accepted.length) {
    throw new Error('Saved credentials are locked by the operating system. Unlock secure storage and restart Volyx Lens before changing API keys.');
  }
  for (const [name, value] of accepted) {
    data.apiKeys[name] = value == null ? '' : String(value).trim();
  }
}

function updateSettingsAndApiKeys(patch, updates) {
  load();
  const previous = data;
  data = clone(data);
  try {
    applyApiKeyUpdates(updates);
    data = deepMerge(data, sanitizeSettingsPatch(patch));
    if (data.fallbackProvider === data.provider) data.fallbackProvider = '';
    if (!data.audio.micEnabled && !data.audio.systemEnabled) data.audio.micEnabled = true;
    save();
  } catch (error) {
    data = previous;
    throw error;
  }
  return publicSettings();
}

function updateApiKeys(updates) {
  return updateSettingsAndApiKeys({}, updates);
}

module.exports = {
  getSettings: () => load(),
  getPublicSettings: () => publicSettings(),
  setSettings,
  updateSettingsAndApiKeys,
  updateApiKeys,
  clearApiKey(name) { return updateApiKeys({ [name]: '' }); },
  credentialStorageStatus() { return publicSettings().credentialStatus; },
  sanitizeSettingsPatch,
};
