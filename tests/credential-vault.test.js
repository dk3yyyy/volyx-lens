const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCredentialVault } = require('../src/credential-vault');

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^protected:/, ''),
  };
}

test('credential vault encrypts values and decrypts them without plaintext persistence', () => {
  const vault = createCredentialVault(fakeSafeStorage(true));
  const record = vault.seal({ azure: 'azure-secret', openai: '' });
  assert.equal(record.mode, 'safeStorage');
  assert.equal(JSON.stringify(record).includes('azure-secret'), false);
  assert.deepEqual(vault.open(record), { azure: 'azure-secret' });
  assert.equal(vault.isSecure(), true);
});

test('credential vault explicitly reports plaintext fallback when secure storage is unavailable', () => {
  const vault = createCredentialVault(fakeSafeStorage(false));
  const record = vault.seal({ azure: 'temporary-secret' });
  assert.equal(record.mode, 'plaintext-fallback');
  assert.equal(vault.backend(), 'plaintext-fallback');
  assert.deepEqual(vault.open(record), { azure: 'temporary-secret' });
});

test('credential vault does not claim Linux basic_text as secure encryption', { skip: process.platform !== 'linux' }, () => {
  const storage = fakeSafeStorage(true);
  storage.getSelectedStorageBackend = () => 'basic_text';
  const vault = createCredentialVault(storage);
  assert.equal(vault.isSecure(), false);
  assert.equal(vault.seal({ azure: 'fallback-value' }).mode, 'plaintext-fallback');
});

test('credential vault tolerates corrupt encrypted entries without exposing them', () => {
  const storage = fakeSafeStorage(true);
  storage.decryptString = () => { throw new Error('corrupt'); };
  const vault = createCredentialVault(storage);
  assert.deepEqual(vault.open({ mode: 'safeStorage', values: { azure: 'not-valid' } }), {});
});

test('every vault method called by the settings store exists on the vault', () => {
  // The store derives credentialStatus in publicSettings(); calling a vault
  // method that was never implemented throws there and breaks every settings
  // read and atomic save. Guard the call surface against the real vault.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');
  const called = new Set();
  for (const match of source.matchAll(/\bvault\.([A-Za-z_$][\w$]*)\s*\(/g)) called.add(match[1]);
  assert.ok(called.size > 0, 'expected the store to call vault methods');
  const vault = createCredentialVault(fakeSafeStorage(true));
  for (const name of called) {
    assert.equal(typeof vault[name], 'function', `vault.${name} is called by src/store.js but is not implemented`);
  }
});
