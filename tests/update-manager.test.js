const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUpdateManager } = require('../src/update-manager');

function fixture({ packaged = true, platform = 'darwin', releaseBuild = true } = {}) {
  const updater = new EventEmitter();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.checkForUpdates = async () => ({ updateInfo: { version: '0.3.0' } });
  updater.downloadUpdate = async () => ['/tmp/update.zip'];
  updater.quitAndInstall = () => { updater.installed = true; };
  const states = [];
  let factoryCalls = 0;
  const manager = createUpdateManager({
    app: { isPackaged: packaged, getVersion: () => '0.2.0' },
    platform,
    arch: 'arm64',
    releaseBuild,
    updaterFactory: () => { factoryCalls += 1; return updater; },
    emit: (state) => states.push(state),
  });
  return { manager, updater, states, getFactoryCalls: () => factoryCalls };
}

test('development builds explain that signed packaged builds are required', async () => {
  const { manager } = fixture({ packaged: false });
  assert.deepEqual(manager.getState(), {
    supported: false,
    currentVersion: '0.2.0',
    status: 'unsupported',
    message: 'Updates are available in official signed macOS release builds.',
    availableVersion: null,
    progress: null,
  });
  await assert.rejects(manager.check(), /official signed macOS release builds/);
});

test('ad-hoc packaged builds cannot initialize the release updater', async () => {
  const { manager, getFactoryCalls } = fixture({ releaseBuild: false });
  assert.equal(manager.getState().supported, false);
  await assert.rejects(manager.check(), /official signed macOS release builds/);
  assert.equal(getFactoryCalls(), 0);
});

test('manual check never downloads silently and reports an available version', async () => {
  const { manager, updater } = fixture();
  const checking = manager.check();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.channel, 'latest-arm64');
  assert.equal(updater.allowDowngrade, false);
  updater.emit('update-available', { version: '0.3.0' });
  await checking;
  assert.equal(manager.getState().status, 'available');
  assert.equal(manager.getState().availableVersion, '0.3.0');
});

test('download progress is bounded and install is unavailable before verified download', async () => {
  const { manager, updater } = fixture();
  await assert.rejects(manager.install(), /not ready/);
  const checking = manager.check();
  updater.emit('update-available', { version: '0.3.0' });
  await checking;
  let finishDownload;
  updater.downloadUpdate = () => new Promise((resolve) => { finishDownload = resolve; });
  const downloading = manager.download();
  updater.emit('download-progress', { percent: 52.75 });
  assert.equal(manager.getState().progress, 53);
  finishDownload(['/tmp/update.zip']);
  await downloading;
  assert.equal(manager.getState().progress, 100);
  updater.emit('update-downloaded', { version: '0.3.0' });
  assert.equal(manager.getState().status, 'downloaded');
  await manager.install();
  assert.equal(updater.installed, true);
});

test('updater failures are sanitized before reaching the renderer', async () => {
  const { manager, updater } = fixture();
  const checking = manager.check();
  updater.emit('error', new Error('token=secret /Users/private/path latest-mac.yml failed'));
  await checking;
  const state = manager.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.message, 'The update service is unavailable. Try again later.');
  assert.doesNotMatch(JSON.stringify(state), /secret|Users|latest-mac/);
});

test('current and error states clear stale available versions', async () => {
  const { manager, updater } = fixture();
  const firstCheck = manager.check();
  updater.emit('update-available', { version: '0.3.0' });
  await firstCheck;
  assert.equal(manager.getState().availableVersion, '0.3.0');

  const secondCheck = manager.check();
  assert.equal(manager.getState().availableVersion, null);
  updater.emit('update-not-available');
  await secondCheck;
  assert.equal(manager.getState().availableVersion, null);
});

test('a resolved verified download reaches install-ready state even if its event is late', async () => {
  const { manager, updater } = fixture();
  const checking = manager.check();
  updater.emit('update-available', { version: '0.3.0' });
  await checking;
  await manager.download();
  assert.equal(manager.getState().status, 'downloaded');
  assert.equal(manager.getState().progress, 100);
});
