const { validateRemap, normalizeAccelerator } = require('./shortcut-validator');

function createShortcutRegistry({ globalShortcut, platform, definitions, onRegister, onUnregister }) {
  if (!globalShortcut || typeof globalShortcut.register !== 'function' || typeof globalShortcut.isRegistered !== 'function') {
    throw new Error('A globalShortcut adapter is required.');
  }
  const baseDefinitions = Array.isArray(definitions) ? definitions.slice() : [];
  const entries = baseDefinitions.map((def) => ({ ...def }));
  const attempts = new Map();
  const overrides = new Map();

  function currentAccelerator(entry) {
    return overrides.get(entry.id) || entry.accelerator;
  }

  function isRegistered(entry) {
    const accel = currentAccelerator(entry);
    if (attempts.get(entry.id) !== true) return false;
    try { return globalShortcut.isRegistered(accel) === true; }
    catch { return false; }
  }

  function status() {
    return entries.map((entry) => {
      const accelerator = currentAccelerator(entry);
      const registered = isRegistered(entry);
      return {
        id: entry.id,
        accelerator,
        displayAccelerator: platform === 'darwin' ? entry.mac : entry.other,
        feature: entry.feature,
        fallback: entry.fallback,
        registered,
        message: registered ? 'Registered' : 'Unavailable — the operating system or another application may own this shortcut.',
        isCustom: overrides.has(entry.id),
      };
    });
  }

  function register() {
    for (const entry of entries) {
      const accelerator = currentAccelerator(entry);
      if (isRegistered(entry)) continue;
      if (attempts.get(entry.id) === true) {
        try { globalShortcut.unregister(accelerator); } catch {}
        attempts.set(entry.id, false);
      }
      let registered = false;
      try { registered = globalShortcut.register(accelerator, entry.handler) === true; }
      catch { registered = false; }
      attempts.set(entry.id, registered);
      if (registered && typeof onRegister === 'function') onRegister(entry);
      if (!registered && typeof onUnregister === 'function') onUnregister(entry);
    }
    return status();
  }

  function remap(id, newAccelerator) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return { ok: false, error: `Unknown shortcut "${id}".` };
    if (newAccelerator === null) {
      overrides.delete(id);
      attempts.set(entry.id, false);
      try { globalShortcut.register(entry.accelerator, entry.handler); attempts.set(entry.id, true); } catch {}
      return {ok: true, accelerator: entry.accelerator};
    }
    const result = validateRemap({ id, accelerator: newAccelerator, definitions: entries.map((e) => ({ ...e, accelerator: currentAccelerator(e) })), platform });
    if (!result.ok) return result;
    const prevAccel = currentAccelerator(entry);
    overrides.set(id, result.accelerator);
    if (attempts.get(entry.id) === true) {
      try { globalShortcut.unregister(prevAccel); } catch {}
    }
    attempts.set(entry.id, false);
    let registered = false;
    try { registered = globalShortcut.register(result.accelerator, entry.handler) === true; }
    catch { registered = false; }
    attempts.set(entry.id, registered);
    if (registered && typeof onRegister === 'function') onRegister(entry);
    return { ok: true, accelerator: result.accelerator, registered };
  }

  function reset() {
    for (const entry of entries) {
      if (attempts.get(entry.id) === true) {
        try { globalShortcut.unregister(currentAccelerator(entry)); } catch {}
      }
      overrides.delete(entry.id);
      attempts.set(entry.id, false);
    }
    return register();
  }

  function getOverrides() {
    return Object.fromEntries(overrides);
  }

  return Object.freeze({ register, status, remap, reset, getOverrides });
}

module.exports = { createShortcutRegistry };
