const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUpdateManager, releaseChannel } = require('../src/update-manager');

function fixture({ packaged = true, platform = 'darwin', releaseBuild = true, checkResult = undefined } = {}) {
  const updater = new EventEmitter();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.checkForUpdates = async () => (
    checkResult === undefined ? { updateInfo: { version: '0.3.0' } } : checkResult
  );
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
    installable: false,
    currentVersion: '0.2.0',
    status: 'unsupported',
    message: 'This build cannot install updates automatically. Use Open Latest Release to download the current version.',
    availableVersion: null,
    releaseUrl: null,
    progress: null,
    lastCheckedAt: null,
  });
  await assert.rejects(manager.check(), /cannot install updates automatically/);
});

test('ad-hoc packaged builds cannot initialize the release updater', async () => {
  const { manager, getFactoryCalls } = fixture({ releaseBuild: false });
  assert.equal(manager.getState().supported, false);
  await assert.rejects(manager.check(), /cannot install updates automatically/);
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

test('Windows and Linux packaged builds support release updates on their platform channel', async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({ updateInfo: { version: '0.3.0' } });
  const states = [];
  const manager = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '0.2.0' },
    platform: 'win32',
    arch: 'x64',
    releaseBuild: true,
    updaterFactory: () => updater,
    emit: (state) => states.push(state),
  });
  assert.equal(manager.getState().supported, true);
  const checking = manager.check();
  updater.emit('update-available', { version: '0.3.0' });
  await checking;
  assert.equal(updater.channel, 'latest');
  assert.equal(manager.getState().status, 'available');
});

test('Linux release updates use per-architecture channels', () => {
  assert.equal(releaseChannel('linux', 'x64'), 'latest-x64');
  assert.equal(releaseChannel('linux', 'arm64'), 'latest-arm64');
});

test('development Windows builds explain that packaged builds are required', async () => {
  const { manager } = fixture({ packaged: false, platform: 'win32' });
  assert.deepEqual(manager.getState(), {
    supported: false,
    installable: false,
    currentVersion: '0.2.0',
    status: 'unsupported',
    message: 'This build cannot install updates automatically. Use Open Latest Release to download the current version.',
    availableVersion: null,
    releaseUrl: null,
    progress: null,
    lastCheckedAt: null,
  });
  await assert.rejects(manager.check(), /cannot install updates automatically/);
});

test('a check that resolves without an event still reaches a terminal state', async () => {
  // electron-updater can resolve without emitting update-available or
  // update-not-available, which used to leave the panel on "Checking…" (VR-15).
  for (const [checkResult, expected, availableVersion] of [
    [null, 'current', null],
    [{ updateInfo: { version: '0.2.0' } }, 'current', null],
    [{ updateInfo: { version: '0.4.0' } }, 'available', '0.4.0'],
    [{ updateInfo: {} }, 'current', null],
  ]) {
    const { manager, states } = fixture({ checkResult });
    const state = await manager.check();
    assert.notEqual(state.status, 'checking', 'the check must settle');
    assert.equal(state.status, expected, `checkResult ${JSON.stringify(checkResult)}`);
    assert.equal(state.availableVersion, availableVersion);
    assert.equal(states[states.length - 1].status, expected, 'the final state is also emitted to the UI');
  }
});

test('a check whose result is already new information keeps the event-driven message', async () => {
  const { manager, updater, states } = fixture({ checkResult: { updateInfo: { version: '0.4.0' } } });
  // The event fires first, as it does in practice; the result must not overwrite it.
  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '0.4.0' });
    return { updateInfo: { version: '0.4.0' } };
  };
  const state = await manager.check();
  assert.equal(state.status, 'available');
  assert.equal(state.message, 'Volyx Lens 0.4.0 is available.');
  assert.equal(states.filter((entry) => entry.status === 'available').length, 1, 'one available state, not two');
});

function releaseFixture({ release = { version: '0.3.0', url: 'https://github.com/dk3yyyy/volyx-lens/releases/tag/v0.3.0' }, latest } = {}) {
  const checker = { latest: latest || (async () => release) };
  const manager = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '0.2.0' },
    platform: 'darwin',
    arch: 'arm64',
    releaseBuild: false,
    updaterFactory: () => { throw new Error('the updater must not be initialized for an unsigned build'); },
    releaseChecker: checker,
    emit: () => {},
  });
  return manager;
}

test('an unsigned build can report a newer release without being able to install it', async () => {
  const manager = releaseFixture();
  assert.equal(manager.getState().supported, true, 'it can check');
  assert.equal(manager.getState().installable, false, 'it cannot install');

  const state = await manager.check();
  assert.equal(state.status, 'available');
  assert.equal(state.availableVersion, '0.3.0');
  assert.equal(state.releaseUrl, 'https://github.com/dk3yyyy/volyx-lens/releases/tag/v0.3.0');
  await assert.rejects(manager.download(), /installs updates by hand/);
  await assert.rejects(manager.install(), /installs updates by hand/);
});

test('an unsigned build reports up to date when the published release is not newer', async () => {
  const manager = releaseFixture({ release: { version: '0.2.0', url: 'https://github.com/dk3yyyy/volyx-lens/releases/tag/v0.2.0' } });
  const state = await manager.check();
  assert.equal(state.status, 'current');
  assert.equal(state.availableVersion, null);
});

test('an unsigned build says so when no release is published yet', async () => {
  const manager = releaseFixture({ release: null });
  const state = await manager.check();
  assert.equal(state.status, 'current');
  assert.match(state.message, /No published release/);
});

test('an unsigned build reports a failed lookup without pretending it is up to date', async () => {
  const manager = releaseFixture({ latest: async () => { throw new Error('offline'); } });
  const state = await manager.check();
  assert.equal(state.status, 'error');
  assert.match(state.message, /GitHub could not be reached/);
  assert.equal(state.availableVersion, null);
});

test('a packaged build with no checker and no release flag stays unsupported', () => {
  const manager = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '0.2.0' },
    platform: 'darwin',
    arch: 'arm64',
    releaseBuild: false,
    updaterFactory: () => { throw new Error('unused'); },
    emit: () => {},
  });
  assert.equal(manager.getState().supported, false);
  assert.equal(manager.getState().installable, false);
});

test('a release that stopped publishing metadata points at the release page', async () => {
  // 0.7.5 shipped Windows with the updater armed and latest.yml alongside it.
  // 0.7.6 publishes no metadata for an unsigned installer, so those clients hit
  // a channel-file 404. That is not an outage and must not look like one.
  const { manager, updater } = fixture();
  await manager.check(); // initialises the updater and its listeners
  const error = new Error('Cannot find channel "latest.yml" in the latest release artifacts');
  error.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
  updater.emit('error', error);
  const state = manager.getState();
  assert.equal(state.status, 'unavailable');
  assert.match(state.message, /release page/);
  assert.equal(state.releaseUrl, 'https://github.com/dk3yyyy/volyx-lens/releases/latest');
});

test('an ordinary service failure still reads as a retryable error', async () => {
  const { manager, updater } = fixture();
  await manager.check();
  updater.emit('error', new Error('ETIMEDOUT while contacting the update server'));
  assert.equal(manager.getState().status, 'error');
  assert.match(manager.getState().message, /Try again later/);
});

test('a bare 404 is treated the same as the channel-file error code', async () => {
  // Providers do not all wrap the status in ERR_UPDATER_CHANNEL_FILE_NOT_FOUND;
  // a plain HttpError with a 404 has to reach the same conclusion.
  const { manager, updater } = fixture();
  await manager.check();
  const error = new Error('Not Found');
  error.statusCode = 404;
  updater.emit('error', error);
  assert.equal(manager.getState().status, 'unavailable');
});

test('a finished check carries a numeric lastCheckedAt and a running check does not', async () => {
  const { manager, states } = fixture();
  const before = Date.now();
  const checking = manager.check();
  // check() settles the 'checking' state synchronously, before the request can
  // finish, so this is the state the pane sees while the work is in flight.
  const running = manager.getState();
  assert.equal(running.status, 'checking');
  assert.equal(running.lastCheckedAt, null, 'a check in progress has not finished yet');

  const settled = await checking;
  assert.equal(settled.status, 'available');
  assert.equal(typeof settled.lastCheckedAt, 'number');
  assert.ok(settled.lastCheckedAt >= before, 'the timestamp is the completion time');
  assert.ok(settled.lastCheckedAt <= Date.now());

  const checkingStates = states.filter((state) => state.status === 'checking');
  assert.ok(checkingStates.length > 0);
  for (const state of checkingStates) {
    assert.equal(state.lastCheckedAt, null, 'the timestamp is not set when the request starts');
  }
  assert.ok(states.every((state) => state.status === 'checking' || typeof state.lastCheckedAt === 'number'));
});

test('a failed check still records when it finished', async () => {
  const { manager, updater } = fixture();
  const before = Date.now();
  const checking = manager.check();
  updater.emit('error', new Error('offline'));
  await checking;
  const state = manager.getState();
  assert.equal(state.status, 'error');
  assert.equal(typeof state.lastCheckedAt, 'number');
  assert.ok(state.lastCheckedAt >= before);
});

test('the release-page checker path records a completion too', async () => {
  const manager = releaseFixture();
  assert.equal(manager.getState().lastCheckedAt, null);
  const state = await manager.check();
  assert.equal(typeof state.lastCheckedAt, 'number');
  assert.equal(manager.getState().lastCheckedAt, state.lastCheckedAt);
});

test('a download failure does not claim a check just happened', async () => {
  const { manager, updater } = fixture();
  const checking = manager.check();
  updater.emit('update-available', { version: '0.3.0' });
  await checking;
  const completedAt = manager.getState().lastCheckedAt;
  assert.equal(typeof completedAt, 'number');

  // Leave a gap wide enough that a wrongly stamped Date.now() would differ.
  await new Promise((resolve) => setTimeout(resolve, 5));
  updater.downloadUpdate = async () => { throw new Error('disk full'); };
  await manager.download();
  assert.equal(manager.getState().status, 'error');
  assert.equal(manager.getState().lastCheckedAt, completedAt, 'only a check, not a download, moves the timestamp');
});

