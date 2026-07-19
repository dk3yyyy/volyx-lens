function createCredentialVault(safeStorage) {
  function secureAvailable() {
    try {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
      const backend = process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
        ? safeStorage.getSelectedStorageBackend()
        : '';
      return backend !== 'basic_text';
    }
    catch { return false; }
  }

  function seal(values = {}) {
    if (!secureAvailable()) return { version: 1, mode: 'plaintext-fallback', values: { ...values } };
    const encrypted = {};
    for (const [name, value] of Object.entries(values)) {
      if (!value) continue;
      encrypted[name] = safeStorage.encryptString(String(value)).toString('base64');
    }
    return { version: 1, mode: 'safeStorage', values: encrypted };
  }

  function openWithStatus(record = {}) {
    if (!record || typeof record !== 'object') return { values: {}, failedNames: [] };
    if (record.mode === 'plaintext-fallback') return { values: { ...(record.values || {}) }, failedNames: [] };
    const encodedValues = record.values && typeof record.values === 'object' ? record.values : {};
    if (record.mode !== 'safeStorage') return { values: {}, failedNames: [] };
    if (!secureAvailable()) return { values: {}, failedNames: Object.keys(encodedValues) };
    const values = {};
    const failedNames = [];
    for (const [name, encoded] of Object.entries(encodedValues)) {
      try { values[name] = safeStorage.decryptString(Buffer.from(String(encoded), 'base64')); }
      catch { failedNames.push(name); }
    }
    return { values, failedNames };
  }

  function open(record = {}) { return openWithStatus(record).values; }

  return {
    seal,
    open,
    openWithStatus,
    isSecure: secureAvailable,
    backend: () => secureAvailable() ? 'safeStorage' : 'plaintext-fallback',
  };
}

module.exports = { createCredentialVault };
