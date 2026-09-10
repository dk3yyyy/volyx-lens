// Validates keyboard shortcut accelerators, normalizes keyboard events into
// accelerator strings, and detects conflicts between shortcuts or with
// reserved system shortcuts.
const SYSTEM_RESERVED = Object.freeze({
  darwin: Object.freeze([
    'CommandOrControl+Space',
    'CommandOrControl+Tab',
    'CommandOrControl+Shift+Tab',
    'CommandOrControl+`',
    'CommandOrControl+W',
    'CommandOrControl+Q',
    'CommandOrControl+M',
    'CommandOrControl+H',
    'CommandOrControl+Option+H',
  ]),
  linux: Object.freeze([
    'CommandOrControl+Alt+L',
    'CommandOrControl+Alt+Delete',
    'CommandOrControl+Shift+Escape',
  ]),
  win32: Object.freeze([
    'CommandOrControl+Alt+Delete',
    'CommandOrControl+Shift+Escape',
    'Alt+F4',
    'CommandOrControl+Escape',
  ]),
});

const MODIFIER_ORDER = Object.freeze(['CommandOrControl', 'Alt', 'Control', 'Meta', 'Shift', 'Super']);

const VALID_KEY_PATTERN = /^[A-Z0-9]$|^(F[1-9]|F1[0-2])$|^(Enter|Return|Tab|Space|Backspace|Delete|Escape|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Insert|Pause|CapsLock|NumLock|ScrollLock|PrintScreen)$|^([.,;/\\=`\[\]'-])$/;

function isModifier(key) {
  return ['Control', 'Ctrl', 'Alt', 'Shift', 'Meta', 'Super', 'Command', 'Cmd'].includes(key);
}

function normalizeAccelerator(accelerator) {
  if (typeof accelerator !== 'string') return null;
  const parts = accelerator.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const modifiers = new Set();
  let key = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'commandorcontrol' || lower === 'cmdorctrl') modifiers.add('CommandOrControl');
    else if (lower === 'control' || lower === 'ctrl') modifiers.add('Control');
    else if (lower === 'alt' || lower === 'option') modifiers.add('Alt');
    else if (lower === 'shift') modifiers.add('Shift');
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers.add('Meta');
    else if (lower === 'super') modifiers.add('Super');
    else if (part.length === 1) key = part.toUpperCase();
    else if (part.length > 1) key = part.charAt(0).toUpperCase() + part.slice(1);
  }
  if (!key) return null;
  if (key.length === 1 && key.match(/[a-z]/i)) key = key.toUpperCase();

  const ordered = [];
  for (const mod of MODIFIER_ORDER) {
    if (modifiers.has(mod)) ordered.push(mod);
  }
  if (ordered.length === 0) return null;
  return [...ordered, key].join('+');
}

function eventToAccelerator(event) {
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Meta');
  if (modifiers.length === 0) return null;

  let key = event.key;
  if (key === ' ') key = 'Space';
  else if (key === 'Enter') key = 'Enter';
  else if (key.length === 1) key = key.toUpperCase();
  if (!key) return null;

  const raw = [...modifiers, key].join('+');
  return normalizeAccelerator(raw);
}

function isValidAccelerator(accelerator) {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return false;
  const parts = normalized.split('+');
  const key = parts[parts.length - 1];
  return VALID_KEY_PATTERN.test(key);
}

function canonicalizeAccelerator(accelerator) {
  return normalizeAccelerator(accelerator);
}

function isReservedAccelerator(accelerator, platform = 'darwin') {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return true;
  const reserved = SYSTEM_RESERVED[platform] || [];
  const normalizedParts = normalized.split('+');
  return reserved.some((entry) => {
    const entryNorm = normalizeAccelerator(entry);
    if (!entryNorm) return false;
    const entryParts = entryNorm.split('+');
    if (entryParts.length !== normalizedParts.length) return false;
    const entryKey = entryParts[entryParts.length - 1];
    const normKey = normalizedParts[normalizedParts.length - 1];
    if (entryKey !== normKey) return false;
    const entryMods = new Set(entryParts.slice(0, -1));
    const normMods = new Set(normalizedParts.slice(0, -1));
    for (const mod of normMods) {
      if (mod === 'Control' || mod === 'Meta' || mod === 'CommandOrControl') {
        const hasPrimary = [...entryMods].some((m) => m === 'CommandOrControl' || m === 'Control' || m === 'Meta');
        if (!hasPrimary) return false;
        entryMods.delete([...entryMods].find((m) => m === 'CommandOrControl' || m === 'Control' || m === 'Meta'));
      } else if (!entryMods.has(mod)) {
        return false;
      } else {
        entryMods.delete(mod);
      }
    }
    return true;
  });
}

// Detects conflicts among a set of shortcut definitions. Returns a map of
// accelerator -> array of ids that share it. Only conflicts (len > 1) are
// included. System-reserved accelerators are also flagged.
function findConflicts(definitions, platform = 'darwin') {
  const byAccelerator = new Map();
  for (const def of definitions) {
    const normalized = normalizeAccelerator(def.accelerator);
    if (!normalized) continue;
    if (!byAccelerator.has(normalized)) byAccelerator.set(normalized, []);
    byAccelerator.get(normalized).push(def.id);
  }
  const conflicts = [];
  for (const [accelerator, ids] of byAccelerator) {
    if (ids.length > 1) {
      conflicts.push({ accelerator, ids, kind: 'duplicate' });
    }
    if (isReservedAccelerator(accelerator, platform)) {
      conflicts.push({ accelerator, ids, kind: 'system' });
    }
  }
  return conflicts;
}

// Validates a proposed remapping. Returns { ok, accelerator, conflicts, error }.
function validateRemap({ id, accelerator, definitions, platform = 'darwin' }) {
  if (!definitions.some(d => d.id === id)) return {ok: false, error: 'Unknown shortcut.'};
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return { ok: false, error: 'Not a valid key combination.' };
  if (!isValidAccelerator(normalized)) return { ok: false, error: 'That key is not allowed as a shortcut.' };
  if (isReservedAccelerator(normalized, platform)) {
    return { ok: false, accelerator: normalized, error: 'That shortcut is reserved by the operating system.' };
  }

  const simulated = definitions.map((def) => {
    if (def.id === id) return { ...def, accelerator: normalized };
    return def;
  });

  const conflicts = findConflicts(simulated, platform)
    .filter((conflict) => conflict.ids.includes(id));

  if (conflicts.length > 0) {
    return { ok: false, accelerator: normalized, conflicts, error: conflicts[0].kind === 'duplicate' ? 'That shortcut is already in use.' : 'That shortcut is reserved by the operating system.' };
  }

  return { ok: true, accelerator: normalized, conflicts: [] };
}

// Sanitizes a shortcuts patch: keeps only valid, non-conflicting overrides
// against the default definitions. Returns { valid: {id: accelerator}, invalid: [{id, error}] }.
function sanitizeShortcutsPatch({ patch = {}, defaultDefinitions = [], platform = 'darwin' }) {
  const valid = {};
  const invalid = [];
  const workingDefs = defaultDefinitions.map((def) => ({ ...def }));

  for (const [id, rawAccelerator] of Object.entries(patch)) {
    const defExists = defaultDefinitions.some((def) => def.id === id);
    if (!defExists) {
      invalid.push({ id, error: `Unknown shortcut "${id}".` });
      continue;
    }
    const result = validateRemap({ id, accelerator: rawAccelerator, definitions: workingDefs, platform });
    if (!result.ok) {
      invalid.push({ id, error: result.error });
      continue;
    }
    valid[id] = result.accelerator;
    const idx = workingDefs.findIndex((def) => def.id === id);
    if (idx !== -1) workingDefs[idx] = { ...workingDefs[idx], accelerator: result.accelerator };
  }

  return { valid, invalid };
}

// Merges custom shortcut overrides onto default definitions.
function applyShortcuts({ defaultDefinitions = [], overrides = {} }) {
  return defaultDefinitions.map((def) => {
    const override = overrides[def.id];
    if (override) return { ...def, accelerator: override };
    return def;
  });
}

module.exports = {
  normalizeAccelerator,
  eventToAccelerator,
  isValidAccelerator,
  isReservedAccelerator,
  findConflicts,
  validateRemap,
  sanitizeShortcutsPatch,
  applyShortcuts,
  SYSTEM_RESERVED,
};
