const test = require('node:test');
const assert = require('node:assert/strict');

const { requestMediaPermission, PRIVACY_PANES } = require('../src/permissions');

function harness({ statuses, microphoneGranted = true, screenError = null } = {}) {
  const statusQueue = [...(statuses || [])];
  const calls = { status: [], ask: [], sources: 0, opened: [] };
  const dependencies = {
    platform: 'darwin',
    systemPreferences: {
      getMediaAccessStatus(kind) {
        calls.status.push(kind);
        return statusQueue.length ? statusQueue.shift() : 'unknown';
      },
      async askForMediaAccess(kind) {
        calls.ask.push(kind);
        return microphoneGranted;
      },
    },
    desktopCapturer: {
      async getSources(options) {
        calls.sources += 1;
        assert.deepEqual(options.types, ['screen']);
        if (screenError) throw screenError;
        return [{ id: 'screen:1' }];
      },
    },
    async openExternal(url) { calls.opened.push(url); },
  };
  return { dependencies, calls };
}

test('microphone permission uses the native macOS consent prompt', async () => {
  const { dependencies, calls } = harness({ statuses: ['not-determined', 'granted'] });
  const result = await requestMediaPermission('microphone', dependencies);

  assert.equal(result.granted, true);
  assert.equal(result.status, 'granted');
  assert.deepEqual(calls.ask, ['microphone']);
  assert.deepEqual(calls.opened, []);
});

test('denied microphone permission opens the correct System Settings pane', async () => {
  const { dependencies, calls } = harness({ statuses: ['denied', 'denied'], microphoneGranted: false });
  const result = await requestMediaPermission('microphone', dependencies);

  assert.equal(result.granted, false);
  assert.equal(result.settingsOpened, true);
  assert.deepEqual(calls.opened, [PRIVACY_PANES.microphone]);
});

test('screen permission triggers desktop capture and rechecks macOS status', async () => {
  const { dependencies, calls } = harness({ statuses: ['not-determined', 'granted'] });
  const result = await requestMediaPermission('screen', dependencies);

  assert.equal(result.granted, true);
  assert.equal(calls.sources, 1);
  assert.deepEqual(calls.ask, []);
  assert.deepEqual(calls.opened, []);
});

test('denied screen permission opens the Screen Recording settings pane', async () => {
  const { dependencies, calls } = harness({
    statuses: ['denied', 'denied'],
    screenError: new Error('screen access denied'),
  });
  const result = await requestMediaPermission('screen', dependencies);

  assert.equal(result.granted, false);
  assert.equal(result.settingsOpened, true);
  assert.deepEqual(calls.opened, [PRIVACY_PANES.screen]);
});

test('invalid permission types fail closed', async () => {
  const { dependencies } = harness();
  await assert.rejects(requestMediaPermission('camera', dependencies), /Unsupported permission type/);
});
