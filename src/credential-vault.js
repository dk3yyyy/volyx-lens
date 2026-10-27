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
    // Without a secure backend there is no safe way to write a provider key: any copy
    // of userData, backup or support bundle would carry it. The key stays in memory
    // for this session and the record says so (VR-22).
    if (!secureAvailable()) return { version: 1, mode: 'memory-only', values: {} };
    const encrypted = {};
    for (const [name, value] of Object.entries(values)) {
      if (!value) continue;
      encrypted[name] = safeStorage.encryptString(String(value)).toString('base64');
    }
    return { version: 1, mode: 'safeStorage', values: encrypted };
  }

  function openWithStatus(record = {}) {
    if (!record || typeof record !== 'object') return { values: {}, failedNames: [], plaintext: false };
    if (record.mode === 'plaintext-fallback') {
      // Reading an older plaintext record is still allowed so the session keeps
      // working; the caller rewrites it without values on the next save.
      return { values: { ...(record.values || {}) }, failedNames: [], plaintext: true };
    }
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

  function getSecurityStatus() {
    const secure = secureAvailable();
    return {
      secure,
      persisted: secure,
      warning: secure ? '' : 'Secure storage is unavailable, so API keys are kept for this session only and are not written to disk. They will be gone after a restart.',
    };
  }

  return {
    seal,
    open,
    openWithStatus,
    isSecure: secureAvailable,
    backend: () => secureAvailable() ? 'safeStorage' : 'plaintext-fallback',
    getSecurityStatus,
  };
}

module.exports = { createCredentialVault };
