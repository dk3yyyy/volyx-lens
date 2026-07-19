function createShortcutRegistry({ globalShortcut, platform, definitions }) {
  if (!globalShortcut || typeof globalShortcut.register !== 'function' || typeof globalShortcut.isRegistered !== 'function') {
    throw new Error('A globalShortcut adapter is required.');
  }
  const entries = Array.isArray(definitions) ? definitions.slice() : [];
  const attempts = new Map();

  function isRegistered(entry) {
    if (attempts.get(entry.id) !== true) return false;
    try { return globalShortcut.isRegistered(entry.accelerator) === true; }
    catch { return false; }
  }

  function status() {
    return entries.map((entry) => {
      const registered = isRegistered(entry);
      return {
        id: entry.id,
        accelerator: entry.accelerator,
        displayAccelerator: platform === 'darwin' ? entry.mac : entry.other,
        feature: entry.feature,
        fallback: entry.fallback,
        registered,
        message: registered ? 'Registered' : 'Unavailable — macOS, the operating system, or another application may own this shortcut.',
      };
    });
  }

  function register() {
    for (const entry of entries) {
      if (isRegistered(entry)) continue;
      try { attempts.set(entry.id, globalShortcut.register(entry.accelerator, entry.handler) === true); }
      catch { attempts.set(entry.id, false); }
    }
    return status();
  }

  return Object.freeze({ register, status });
}

module.exports = { createShortcutRegistry };
