const fs = require('fs');
const path = require('path');
const { createCredentialVault } = require('./credential-vault');

const KINDS = Object.freeze(['resume', 'jobDescription']);
const MAX_TEXT_CHARS = 50000;

function normalizeDocument(kind, document = {}) {
  if (!KINDS.includes(kind)) throw new Error('Unsupported personal-context document type.');
  const text = String(document.text || '').slice(0, MAX_TEXT_CHARS).trim();
  if (!text) throw new Error('The selected document did not contain readable text.');
  return {
    kind,
    name: path.basename(String(document.name || (kind === 'resume' ? 'Resume' : 'Job description'))).slice(0, 180),
    text,
    enabled: document.enabled !== false,
    importedAt: String(document.importedAt || new Date().toISOString()).slice(0, 40),
    truncated: !!document.truncated,
    characters: text.length,
  };
}

function createPersonalContextStore({ userDataPath, safeStorage }) {
  const file = path.join(userDataPath, 'personal-context.json');
  const vault = createCredentialVault(safeStorage);
  let loaded = false;
  let documents = {};
  let persistedRecord = null;
  let locked = false;

  function load() {
    if (loaded) return documents;
    loaded = true;
    try { persistedRecord = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { persistedRecord = null; }
    const openedRecord = vault.openWithStatus(persistedRecord);
    locked = !!(persistedRecord && persistedRecord.mode === 'safeStorage'
      && (!vault.isSecure() || openedRecord.failedNames.length));
    const opened = openedRecord.values;
    for (const kind of KINDS) {
      if (!opened[kind]) continue;
      try { documents[kind] = normalizeDocument(kind, JSON.parse(opened[kind])); }
      catch { documents[kind] = null; }
    }
    return documents;
  }

  function save() {
    load();
    if (locked) throw new Error('Personal context is locked by the operating system. Unlock secure storage and restart Volyx Lens before changing documents.');
    const values = {};
    for (const kind of KINDS) {
      if (documents[kind]) values[kind] = JSON.stringify(documents[kind]);
    }
    const record = vault.seal(values);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {}
    persistedRecord = record;
    locked = record.mode === 'safeStorage' && !vault.isSecure();
  }

  function summary() {
    load();
    const persistedValues = persistedRecord && persistedRecord.values && typeof persistedRecord.values === 'object' ? persistedRecord.values : {};
    return {
      documents: Object.fromEntries(KINDS.map((kind) => {
        const document = documents[kind];
        const lockedPresent = locked && !!persistedValues[kind];
        return [kind, document ? {
          present: true,
          name: document.name,
          enabled: document.enabled,
          importedAt: document.importedAt,
          characters: document.characters,
          truncated: document.truncated,
          preview: document.text.slice(0, 500),
        } : { present: lockedPresent, enabled: false, name: lockedPresent ? 'Saved document' : '' }];
      })),
      secure: vault.isSecure() && !locked,
      backend: locked ? 'locked-safeStorage' : vault.backend(),
      locked,
    };
  }

  return {
    importDocument(kind, document) {
      load();
      if (locked) throw new Error('Personal context is locked by the operating system.');
      documents[kind] = normalizeDocument(kind, document);
      save();
      return summary();
    },
    removeDocument(kind) {
      load();
      if (!KINDS.includes(kind)) throw new Error('Unsupported personal-context document type.');
      if (locked) throw new Error('Personal context is locked by the operating system.');
      delete documents[kind];
      save();
      return summary();
    },
    setEnabled(kind, enabled) {
      load();
      if (!KINDS.includes(kind)) throw new Error('Unsupported personal-context document type.');
      if (locked) throw new Error('Personal context is locked by the operating system.');
      if (!documents[kind]) throw new Error('Import the document before enabling it.');
      documents[kind].enabled = !!enabled;
      save();
      return summary();
    },
    getEnabledDocuments() {
      load();
      if (locked) return [];
      return KINDS.map((kind) => documents[kind]).filter((document) => document && document.enabled).map((document) => ({ ...document }));
    },
    getSummary: summary,
    file,
  };
}

module.exports = { createPersonalContextStore, normalizeDocument, KINDS, MAX_TEXT_CHARS };
