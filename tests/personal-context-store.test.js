const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPersonalContextStore } = require('../src/personal-context-store');

function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-lens-personal-context-')); }
function secureStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (buffer) => String(buffer).replace(/^sealed:/, ''),
  };
}

test('personal context is encrypted locally and public summaries expose no full document or path', () => {
  const directory = temporaryDirectory();
  const store = createPersonalContextStore({ userDataPath: directory, safeStorage: secureStorage() });
  const secretText = 'Joshua built reliable AI agents and automation systems.';
  const summary = store.importDocument('resume', { name: '/private/source/Joshua Resume.pdf', text: secretText });
  assert.equal(summary.documents.resume.name, 'Joshua Resume.pdf');
  assert.equal(summary.documents.resume.preview, secretText);
  assert.equal(summary.documents.resume.enabled, true);
  const persisted = fs.readFileSync(path.join(directory, 'personal-context.json'), 'utf8');
  assert.equal(persisted.includes(secretText), false);
  assert.equal(persisted.includes('/private/source'), false);
  assert.equal(store.getEnabledDocuments()[0].text, secretText);

  const disabled = store.setEnabled('resume', false);
  assert.equal(disabled.documents.resume.enabled, false);
  assert.equal(store.getEnabledDocuments().length, 0);
  assert.equal(store.removeDocument('resume').documents.resume.present, false);
});

test('locked encrypted personal context cannot be read, replaced, or erased', () => {
  const directory = temporaryDirectory();
  createPersonalContextStore({ userDataPath: directory, safeStorage: secureStorage() })
    .importDocument('resume', { name: 'resume.txt', text: 'Private employment history' });
  const locked = createPersonalContextStore({ userDataPath: directory, safeStorage: secureStorage(false) });
  const summary = locked.getSummary();
  assert.equal(summary.locked, true);
  assert.equal(summary.documents.resume.present, true);
  assert.equal(summary.documents.resume.preview, undefined);
  assert.deepEqual(locked.getEnabledDocuments(), []);
  assert.throws(() => locked.removeDocument('resume'), /locked/i);
  assert.throws(() => locked.importDocument('resume', { name: 'new.txt', text: 'replacement' }), /locked/i);
});

test('personal context copied from an incompatible app identity fails closed', () => {
  const directory = temporaryDirectory();
  createPersonalContextStore({ userDataPath: directory, safeStorage: secureStorage() })
    .importDocument('resume', { name: 'resume.txt', text: 'Private employment history' });
  const incompatibleStorage = secureStorage();
  incompatibleStorage.decryptString = () => { throw new Error('wrong application identity'); };
  const locked = createPersonalContextStore({ userDataPath: directory, safeStorage: incompatibleStorage });
  const summary = locked.getSummary();
  assert.equal(summary.locked, true);
  assert.equal(summary.documents.resume.present, true);
  assert.deepEqual(locked.getEnabledDocuments(), []);
  assert.throws(() => locked.removeDocument('resume'), /locked/i);
});
