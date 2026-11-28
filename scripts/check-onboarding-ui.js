const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FIRST_PAINT_TIMEOUT_MS,
  installHarnessGuards,
  trackRendererConsole,
  waitFor,
  waitForEntryAnimation,
  waitForHost,
  waitForPaint,
  waitForRendererReady,
} = require('./ui-harness-helpers');

const root = path.join(__dirname, '..');
const screenshotDir = process.env.VOLYX_LENS_ONBOARDING_SCREENSHOT_DIR || '';
const emptyContext = { count: 0, maxCaptures: null, maxTotalBytes: 96 * 1024 * 1024, totalBytes: 0, pinnedCount: 0, revision: 0 };
// Local-speech fixtures are real catalog ids and real artifact sizes so the
// recommendation, size label, and estimate are exercised, not stubbed strings.
const speechCatalog = [
  {
    id: 'parakeet-unified-en', name: 'Parakeet Unified English', runtime: 'transcribe-cpp',
    streaming: true, languageCoverage: 'English', languages: ['en'],
    artifact: { format: 'gguf', bytes: 731357568, estimatedSizeMb: 698, filename: 'parakeet-unified-en-0.6b-Q8_0.gguf' },
  },
  {
    id: 'qwen3-asr-0.6b', name: 'Qwen3-ASR 0.6B', runtime: 'transcribe-cpp',
    streaming: false, languageCoverage: '30 languages', languages: ['en', 'zh'],
    artifact: { format: 'gguf', bytes: 850423456, estimatedSizeMb: 811, filename: 'Qwen3-ASR-0.6B-Q8_0.gguf' },
  },
  {
    id: 'sensevoice-small', name: 'SenseVoiceSmall', runtime: 'transcribe-cpp',
    streaming: false, languageCoverage: 'Chinese, English, Cantonese, Japanese, Korean', languages: ['en', 'zh', 'yue', 'ja', 'ko'],
    artifact: { format: 'gguf', bytes: 252684608, estimatedSizeMb: 241, filename: 'SenseVoiceSmall-Q8_0.gguf' },
  },
];
const installedSpeechModels = new Set(['qwen3-asr-0.6b']);
let ggufRuntimeAvailable = true;
let systemMemoryMb = 16384;
let releaseSpeechDownload = null;
let rejectSpeechDownload = null;
let cancelSpeechDownloadRequested = false;
const downloadedSpeechModels = [];
function buildSpeechModels() {
  return speechCatalog.map((model) => ({
    ...model,
    artifact: { ...model.artifact },
    runtimeAvailable: ggufRuntimeAvailable,
    installed: installedSpeechModels.has(model.id),
    loaded: false,
    warmed: false,
  }));
}

const settings = {
  provider: 'openai', fallbackProvider: '', smart: false, onboarded: false, questionDetection: true, assistContext: 'both',
  credentialStatus: { present: {}, secure: true, backend: 'safeStorage' },
  models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }, anthropic: {}, gemini: {}, azure: {}, deepseek: {}, groq: {}, openrouter: {}, ollama: {} },
  endpoints: { azure: '', azureRealtime: '' },
  transcription: { mode: 'realtime', realtimeProvider: 'openai', fallbackModel: 'gpt-4o-mini-transcribe', geminiFallbackModel: 'gemini-3.5-flash', offlineEnabled: false, offlineCloudFallback: false, language: '', delay: 'low' },
  audio: { inputDeviceId: '', micEnabled: true, systemEnabled: true, sensitivity: 'balanced', silenceMs: 700, costWarningMinutes: 30, maxSessionMinutes: 60 }
};

ipcMain.handle('settings:get', () => ({
  ...settings,
  speechModels: buildSpeechModels(),
  localSpeech: {
    available: true,
    whisper: { available: true },
    gguf: { available: ggufRuntimeAvailable, reason: ggufRuntimeAvailable ? '' : 'no bundled GGUF worker for this platform' },
  },
}));
ipcMain.handle('settings:set', (_event, patch) => {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && settings[key] && typeof settings[key] === 'object') {
      settings[key] = { ...settings[key], ...value };
    } else {
      settings[key] = value;
    }
  }
  return { ...settings, speechModels: buildSpeechModels() };
});
ipcMain.handle('system:info', () => ({ totalMemMb: systemMemoryMb, platform: process.platform, arch: process.arch }));
ipcMain.handle('speech-models:get', () => buildSpeechModels());
ipcMain.handle('speech-diarizer:get', () => ({ installed: false, runtimeAvailable: false, artifact: { bytes: 139310336 } }));
ipcMain.handle('speech-model:download', async (event, id) => {
  downloadedSpeechModels.push(id);
  cancelSpeechDownloadRequested = false;
  const model = buildSpeechModels().find((entry) => entry.id === id);
  if (!model) throw new Error('Unknown speech model.');
  if (model.installed) return { path: '/fixture/model.gguf', modelId: id, models: buildSpeechModels() };
  event.sender.send('speech:model-progress', { id, progress: 0.2, bytesPerSecond: 1153434, resumedFrom: 0 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  // Mirrors the artifact store's (fraction, detail) callback shape once the
  // main process forwards it: throughput in bytes/second and resumedFrom bytes.
  event.sender.send('speech:model-progress', { id, progress: 0.75, bytesPerSecond: 2411724.8, resumedFrom: 1048576 });
  await new Promise((resolve, reject) => {
    if (cancelSpeechDownloadRequested) {
      reject(new Error('Speech model download was cancelled.'));
      return;
    }
    releaseSpeechDownload = resolve;
    rejectSpeechDownload = reject;
  }).finally(() => {
    releaseSpeechDownload = null;
    rejectSpeechDownload = null;
  });
  installedSpeechModels.add(id);
  return { path: '/fixture/model.gguf', modelId: id, models: buildSpeechModels() };
});
ipcMain.handle('speech-model:cancel-download', () => {
  cancelSpeechDownloadRequested = true;
  if (rejectSpeechDownload) {
    const reject = rejectSpeechDownload;
    rejectSpeechDownload = null;
    reject(new Error('Speech model download was cancelled.'));
  }
  return { canceled: true };
});
ipcMain.handle('personal-context:get', () => ({ documents: {}, secure: true, locked: false }));
ipcMain.handle('workspace-index:get', () => []);
ipcMain.handle('transcript:get', () => []);
    ipcMain.handle('transcript:suppressed-list', () => []);
ipcMain.handle('task-context:get', () => emptyContext);
// The renderer fetches history and its limits on boot. Stub them so the run has
// no "No handler registered" noise masking a real error.
ipcMain.handle('history:list', () => []);
ipcMain.handle('history:limits', () => ({ maxRecords: 200, trashRetentionDays: 30, trashCount: 0 }));
ipcMain.handle('history:memory-list', () => []);

ipcMain.handle('update:get-state', () => ({ supported: false, currentVersion: '0.8.9', status: 'unsupported', message: '', availableVersion: null, progress: null }));
ipcMain.handle('recovery:get', () => null);
ipcMain.handle('task-context:list', () => ({ ...emptyContext, captures: [], offset: 0, limit: 50, total: 0 }));
ipcMain.handle('capture:state', () => ({ active: false, transitioning: false }));
ipcMain.handle('shortcuts:get', () => []);
let developmentPermissionClient = false;
let screenPermissionDenied = false;
function permissionRequestResult(kind) {
  if (process.platform !== 'darwin') {
    if (kind !== 'screen') return { kind, granted: true };
    return screenPermissionDenied
      ? { kind, granted: false, status: 'denied', settingsOpened: false, developmentClient: true }
      : { kind, granted: false, status: 'not-determined', settingsOpened: false, developmentClient: true };
  }
  if (kind !== 'screen') return { kind, granted: true };
  return developmentPermissionClient
    ? { kind, granted: false, status: 'denied', settingsOpened: false, requiresSettings: true, developmentClient: true, message: 'This npm start development build is a separate macOS permission client.' }
    : { kind, granted: false, settingsOpened: false, requiresSettings: true, developmentClient: false };
}
ipcMain.handle('permissions:request', (_event, kind) => permissionRequestResult(kind));
ipcMain.handle('permissions:status', (_event, kind) => ({ kind, status: 'not-determined', granted: false }));
ipcMain.on('mouse:ignore', () => {});

async function capture(win, name) {
  if (!screenshotDir) return;
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}

let win = null;
const consoleLines = [];
const guards = installHarnessGuards({
  app,
  getWindow: () => win,
  label: 'Onboarding UI check',
  consoleLines,
});

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 700, height: 600, minWidth: 500, minHeight: 480, show: false,
    backgroundColor: '#151827',
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  trackRendererConsole(win, { lines: consoleLines });
  // Attach before loadFile so a fast boot cannot send renderer-ready first.
  const booted = waitForRendererReady(ipcMain);
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  await booted;
  win.show();
  win.focus();
  win.webContents.focus();
  // Cold Electron startup can exceed the normal interaction timeout on shared CI
  // runners, and a runner without a window manager does not hand the window
  // focus on its own. Re-ask on every attempt so the assertion is about the
  // app focusing its heading, not about the runner's window manager.
  await waitFor(
    win,
    "document.activeElement && document.activeElement.id === 'ob-title'",
    'initial onboarding heading focus',
    FIRST_PAINT_TIMEOUT_MS,
    () => { win.show(); win.focus(); win.webContents.focus(); },
  );

  const names = ['welcome', 'permissions', 'provider', 'speech', 'sharing', 'ready'];
  const heights = [];
  for (let index = 0; index < names.length; index += 1) {
    // overlayIn scales the dialog while it runs, so sampling geometry before the
    // animation settles measures a smaller dialog than the CSS declares. Wait
    // for the animation (a condition), not for a guessed number of milliseconds.
    await waitForEntryAnimation(win, '#onboard', FIRST_PAINT_TIMEOUT_MS);
    const state = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('#onboard').getBoundingClientRect();
      const content = document.querySelector('#ob-content');
      return {
        active: document.activeElement && document.activeElement.id,
        dialog: { x: dialog.x, y: dialog.y, width: dialog.width, height: dialog.height, right: dialog.right, bottom: dialog.bottom },
        footerHeight: document.querySelector('.ob-footer').getBoundingClientRect().height,
        viewport: { width: innerWidth, height: innerHeight },
        contentOverflowY: content.scrollHeight > content.clientHeight,
        contentScrollHeight: content.scrollHeight,
        contentClientHeight: content.clientHeight,
        documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    assert.equal(state.active, 'ob-title', `${names[index]} should focus its heading`);
    assert.equal(state.documentOverflowX, false, `${names[index]} must not overflow horizontally`);
    assert.equal(state.contentOverflowY, false, `${names[index]} must not scroll at production size (${state.contentScrollHeight}px content in ${state.contentClientHeight}px pane)`);
    assert.ok(Math.abs(state.footerHeight - 54) < 0.1, `${names[index]} should use the compact single-row footer`);
    assert.ok(state.dialog.x >= 0 && state.dialog.y >= 0 && state.dialog.right <= state.viewport.width && state.dialog.bottom <= state.viewport.height, `${names[index]} dialog must fit viewport`);
    heights.push(state.dialog.height);
    await capture(win, names[index]);
    if (index === 2) {
      await win.webContents.executeJavaScript("document.querySelector('#ob-buttons button').click()");
      await waitFor(win, "!document.querySelector('#settings-scrim').classList.contains('hidden') && document.querySelector('#onboard-scrim').classList.contains('hidden')", 'provider settings should open without ending onboarding');
      const providerOpen = await win.webContents.executeJavaScript(`({ onboarded: window.__settings ? window.__settings.onboarded : null, visible: !document.querySelector('#settings-scrim').classList.contains('hidden'), guideHidden: document.querySelector('#onboard-scrim').classList.contains('hidden') })`);
      assert.equal(providerOpen.guideHidden, true, 'opening provider settings should pause the guide');
      assert.equal(settings.onboarded, false, 'opening provider settings must not complete onboarding');
      await win.webContents.executeJavaScript("document.querySelector('#s-close').click()");
      await waitFor(win, "document.querySelector('#onboard-scrim').classList.contains('hidden') === false && document.querySelector('#ob-step-count').textContent === '3 of 6'", 'closing settings should resume the guide at the same step');
      const resumed = await win.webContents.executeJavaScript(`({ step: document.querySelector('#ob-step-count').textContent, active: document.activeElement && document.activeElement.id })`);
      assert.equal(resumed.step, '3 of 6', 'guide should resume at the provider step');
    }
    if (index === 3) {
      // 16 GB fixture recommends the streaming English model, with its real
      // artifact size and an estimate that is labelled approximate.
      await waitFor(win, "document.querySelector('#ob-speech-card') && document.querySelector('#ob-speech-card').dataset.model === 'parakeet-unified-en'", '16 GB speech recommendation');
      const recommended = await win.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('#ob-speech-card');
        return {
          label: document.querySelector('#ob-step-label').textContent,
          model: card.dataset.model,
          badge: document.querySelector('#ob-speech-badge').textContent,
          meta: document.querySelector('#ob-speech-meta').textContent,
          why: document.querySelector('#ob-speech-why').textContent,
          downloadDisabled: document.querySelector('#ob-speech-download').disabled,
          useDisabled: document.querySelector('#ob-speech-use').disabled,
          cancelHidden: document.querySelector('#ob-speech-cancel').classList.contains('hidden'),
          progressHidden: document.querySelector('#ob-speech-progress').classList.contains('hidden')
        };
      })()`);
      assert.equal(recommended.label, 'Speech on this device');
      assert.equal(recommended.model, 'parakeet-unified-en', '16 GB should recommend Parakeet Unified English');
      assert.equal(recommended.badge, 'Recommended');
      assert.match(recommended.meta, /697 MB/, `the size label should come from the artifact (got: ${recommended.meta})`);
      assert.match(recommended.meta, /about 5 min at 20 Mbps/, 'the estimate should use 20 Mbps');
      assert.match(recommended.meta, /approximate/, 'the estimate must be labelled approximate');
      assert.match(recommended.why, /16 GB or more/, 'the step should explain the recommendation');
      assert.equal(recommended.downloadDisabled, false, 'Download should be enabled when the runtime is available');
      assert.equal(recommended.useDisabled, true, 'Use must wait for an installed model');
      assert.equal(recommended.cancelHidden, true);
      assert.equal(recommended.progressHidden, true);
      await capture(win, 'speech');

      // Cancel must stop the download without enabling anything.
      await win.webContents.executeJavaScript("document.querySelector('#ob-speech-download').click()");
      await waitFor(win, "!document.querySelector('#ob-speech-cancel').classList.contains('hidden')", 'cancel action during download');
      await win.webContents.executeJavaScript("document.querySelector('#ob-speech-cancel').click()");
      await waitFor(win, "document.querySelector('#ob-speech-status').textContent.includes('cancelled') && document.querySelector('#ob-speech-progress').classList.contains('hidden')", 'cancelled download state');
      const cancelled = await win.webContents.executeJavaScript(`({
        status: document.querySelector('#ob-speech-status').textContent,
        downloadDisabled: document.querySelector('#ob-speech-download').disabled,
        useDisabled: document.querySelector('#ob-speech-use').disabled,
        downloaded: document.querySelector('#ob-speech-badge').textContent
      })`);
      assert.match(cancelled.status, /current transcription setup is unchanged/, 'cancel should say nothing changed');
      assert.equal(cancelled.downloadDisabled, false, 'Download should be available again after cancelling');
      assert.equal(cancelled.useDisabled, true, 'cancel must not enable Use');
      assert.equal(cancelled.downloaded, 'Recommended', 'a cancelled download must not look installed');

      await win.webContents.executeJavaScript("document.querySelector('#ob-speech-download').click()");
      await waitFor(win, "!document.querySelector('#ob-speech-cancel').classList.contains('hidden') && !document.querySelector('#ob-speech-progress').classList.contains('hidden')", 'download progress UI');
      await waitFor(win, "document.querySelector('#ob-speech-progress').getAttribute('aria-valuenow') === '75'", '75% download progress');
      const progress = await win.webContents.executeJavaScript(`({
        percent: document.querySelector('#ob-speech-progress').getAttribute('aria-valuenow'),
        status: document.querySelector('#ob-speech-status').textContent,
        downloadHidden: document.querySelector('#ob-speech-download').classList.contains('hidden'),
        cancelHidden: document.querySelector('#ob-speech-cancel').classList.contains('hidden')
      })`);
      assert.equal(progress.percent, '75');
      assert.match(progress.status, /75%/, 'progress should show a percent');
      assert.match(progress.status, /2\.3 MB\/s/, 'progress should show speed when the payload carries it');
      assert.match(progress.status, /resumed/, 'progress should say when the transfer resumed');
      assert.equal(progress.downloadHidden, true, 'Download should be replaced by Cancel while bytes arrive');
      assert.equal(progress.cancelHidden, false);
      await capture(win, 'speech-progress');
      assert.ok(releaseSpeechDownload, 'the download should be parked for the progress assertions');
      releaseSpeechDownload();
      releaseSpeechDownload = null;
      await waitFor(win, "document.querySelector('#ob-speech-card').dataset.installed === 'true' && document.querySelector('#ob-speech-badge').textContent === 'Installed'", 'installed model after download');
      const installed = await win.webContents.executeJavaScript(`({
        useDisabled: document.querySelector('#ob-speech-use').disabled,
        downloadDisabled: document.querySelector('#ob-speech-download').disabled,
        status: document.querySelector('#ob-speech-status').textContent
      })`);
      assert.deepEqual(downloadedSpeechModels, ['parakeet-unified-en', 'parakeet-unified-en'], 'Download and retry should use the existing speech-model IPC');
      assert.equal(installed.useDisabled, false, 'Use should be enabled once the model is installed');
      assert.equal(installed.downloadDisabled, true, 'Download should be disabled for an installed model');
      assert.match(installed.status, /installed and verified/i);

      await win.webContents.executeJavaScript("document.querySelector('#ob-speech-use').click()");
      await waitForHost(() => settings.transcription.offlineEnabled === true && settings.transcription.localModelId === 'parakeet-unified-en', 'local speech activation');
      await waitFor(win, "document.querySelector('#ob-speech-use').textContent.includes('Local speech is on')", 'activation reflected in the step');
      const activation = await win.webContents.executeJavaScript(`({ status: document.querySelector('#ob-speech-status').textContent, useDisabled: document.querySelector('#ob-speech-use').disabled })`);
      assert.match(activation.status, /audio stays on this machine/i);
      assert.equal(activation.useDisabled, true, 'Use should not run twice');

      // 12 GB fixture: the multilingual model, already installed, offers Use
      // without a download.
      systemMemoryMb = 12288;
      await win.webContents.executeJavaScript("document.querySelector('#ob-back').click(); document.querySelector('#ob-next').click()");
      await waitFor(win, "document.querySelector('#ob-speech-card') && document.querySelector('#ob-speech-card').dataset.model === 'qwen3-asr-0.6b' && document.querySelector('#ob-speech-card').dataset.installed === 'true'", '8-15 GB installed recommendation');
      const midTier = await win.webContents.executeJavaScript(`({
        why: document.querySelector('#ob-speech-why').textContent,
        useDisabled: document.querySelector('#ob-speech-use').disabled,
        downloadDisabled: document.querySelector('#ob-speech-download').disabled,
        badge: document.querySelector('#ob-speech-badge').textContent
      })`);
      assert.match(midTier.why, /8–15 GB/);
      assert.match(midTier.why, /SenseVoiceSmall/, 'the smaller multilingual alternative should be named');
      assert.equal(midTier.badge, 'Installed');
      assert.equal(midTier.useDisabled, false, 'an installed model should offer Use');
      assert.equal(midTier.downloadDisabled, true);
      await capture(win, 'speech-installed');

      // Less than 8 GB keeps the streaming English model and states its memory
      // need instead of hiding it.
      systemMemoryMb = 6144;
      await win.webContents.executeJavaScript("document.querySelector('#ob-back').click(); document.querySelector('#ob-next').click()");
      await waitFor(win, "document.querySelector('#ob-speech-card') && document.querySelector('#ob-speech-card').dataset.model === 'parakeet-unified-en'", 'low memory recommendation');
      const lowTier = await win.webContents.executeJavaScript(`({ why: document.querySelector('#ob-speech-why').textContent })`);
      assert.match(lowTier.why, /Less than 8 GB/);
      assert.match(lowTier.why, /1\.2 GB/, 'low-memory devices should see the free-memory requirement');

      // An unavailable runtime must say so and disable both actions.
      ggufRuntimeAvailable = false;
      await win.webContents.executeJavaScript("document.querySelector('#ob-back').click(); document.querySelector('#ob-next').click()");
      await waitFor(win, "document.querySelector('#ob-speech-badge') && document.querySelector('#ob-speech-badge').textContent === 'Unavailable'", 'unavailable runtime state');
      const unavailable = await win.webContents.executeJavaScript(`({
        status: document.querySelector('#ob-speech-status').textContent,
        downloadDisabled: document.querySelector('#ob-speech-download').disabled,
        useDisabled: document.querySelector('#ob-speech-use').disabled
      })`);
      assert.match(unavailable.status, /not available on this platform/);
      assert.match(unavailable.status, /no bundled GGUF worker/);
      assert.equal(unavailable.downloadDisabled, true, 'Download must be disabled without a runtime');
      assert.equal(unavailable.useDisabled, true, 'Use must be disabled without a runtime');
      await capture(win, 'speech-unavailable');
      ggufRuntimeAvailable = true;
      systemMemoryMb = 16384;
      await win.webContents.executeJavaScript("document.querySelector('#ob-back').click(); document.querySelector('#ob-next').click()");
      await waitFor(win, "document.querySelector('#ob-speech-card').dataset.model === 'parakeet-unified-en' && document.querySelector('#ob-speech-badge').textContent === 'Installed'", 'restored speech step');
    }
    if (index === 1) {
      if (process.platform !== 'darwin') {
        await win.webContents.executeJavaScript("document.querySelector('[data-permission-kind=\"screen\"]').click()");
        await waitFor(win, "document.querySelector('[data-permission-kind=\"screen\"] .ob-permission-state').textContent === 'Ask on use'", 'browser-managed permission state');
        const askOnUse = await win.webContents.executeJavaScript(`(() => {
          const status = document.querySelector('#ob-permission-status');
          return {
            state: document.querySelector('[data-permission-kind="screen"] .ob-permission-state').textContent,
            status: status.textContent,
            hasAction: Boolean(status.querySelector('.ob-restart')),
            note: document.querySelector('#ob-stage-note').textContent,
            body: document.querySelector('#ob-body').textContent,
          };
        })()`);
        assert.equal(askOnUse.state, 'Ask on use');
        assert.equal(askOnUse.hasAction, false);
        assert.doesNotMatch(askOnUse.status + askOnUse.note + askOnUse.body, /System Settings|macOS/);

        screenPermissionDenied = true;
        await win.webContents.executeJavaScript("document.querySelector('[data-permission-kind=\"screen\"]').click()");
        await waitFor(win, "document.querySelector('#ob-permission-status').textContent.includes('denied')", 'browser-managed denial guidance');
        const denied = await win.webContents.executeJavaScript(`({
          status: document.querySelector('#ob-permission-status').textContent,
          hasAction: Boolean(document.querySelector('#ob-permission-status .ob-restart')),
        })`);
        assert.match(denied.status, /browser or operating system/i);
        assert.equal(denied.hasAction, false);
        assert.doesNotMatch(denied.status, /System Settings|macOS/);
        screenPermissionDenied = false;
      } else {
        await win.webContents.executeJavaScript("document.querySelector('[data-permission-kind=\"screen\"]').click()");
        await waitFor(win, "document.querySelector('#ob-permission-status').classList.contains('has-action')", 'permission recovery action');
        const recovery = await win.webContents.executeJavaScript(`(() => {
          const status = document.querySelector('#ob-permission-status');
          const restart = status.querySelector('.ob-restart');
          const style = getComputedStyle(restart);
          return {
            statusDisplay: getComputedStyle(status).display,
            radius: style.borderRadius,
            height: restart.getBoundingClientRect().height,
            background: style.backgroundColor
          };
        })()`);
        assert.equal(recovery.statusDisplay, 'flex', 'permission recovery should align its message and action');
        assert.equal(recovery.radius, '999px', 'restart action should use the app pill radius');
        assert.ok(Math.abs(recovery.height - 30) < 0.1, 'restart action should stay compact');
        assert.notEqual(recovery.background, 'rgba(0, 0, 0, 0)', 'restart action should use a glass fill');
        await waitForPaint(win);
        const recoveryLayout = await win.webContents.executeJavaScript(`(() => {
          const content = document.querySelector('#ob-content');
          const status = document.querySelector('#ob-permission-status').getBoundingClientRect();
          const contentRect = content.getBoundingClientRect();
          return {
            contentOverflowY: content.scrollHeight > content.clientHeight,
            statusInsideContent: status.left >= contentRect.left && status.right <= contentRect.right && status.bottom <= contentRect.bottom
          };
        })()`);
        assert.equal(recoveryLayout.contentOverflowY, false, 'permission recovery must not make onboarding scroll');
        assert.equal(recoveryLayout.statusInsideContent, true, 'permission recovery must fit inside the content panel');
        await capture(win, 'permission-recovery');

        developmentPermissionClient = true;
        await win.webContents.executeJavaScript("document.querySelector('[data-permission-kind=\"screen\"]').click()");
        await waitFor(win, "document.querySelector('#ob-permission-status').textContent.includes('npm start')", 'development permission identity guidance');
        const developmentRecovery = await win.webContents.executeJavaScript(`({
          text: document.querySelector('#ob-permission-status').textContent,
          state: document.querySelector('[data-permission-kind="screen"] .ob-permission-state').textContent,
          restart: Boolean(document.querySelector('#ob-permission-status .ob-restart'))
        })`);
        assert.match(developmentRecovery.text, /separate from Volyx Lens\.app/i, 'development guidance should explain the separate permission client');
        assert.equal(developmentRecovery.state, 'Use packaged app', 'development permission state should direct users to the packaged app');
        assert.equal(developmentRecovery.restart, false, 'development mismatch must not offer an ineffective relaunch');
        developmentPermissionClient = false;
      }
    }
    if (index < names.length - 1) {
      await win.webContents.executeJavaScript("document.querySelector('#ob-next').click()");
      await waitFor(win, `document.activeElement && document.activeElement.id === 'ob-title' && document.querySelector('#ob-step-count').textContent === '${index + 2} of ${names.length}'`, `${names[index + 1]} heading focus`);
    }
  }
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `all onboarding steps should keep a stable shell height: ${heights.join(', ')}`);

  const reverseFromHeading = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#ob-title').focus();
    document.querySelector('#ob-title').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    return document.activeElement && document.activeElement.id;
  })()`);
  assert.equal(reverseFromHeading, 'ob-next', 'Shift+Tab from the heading should wrap to the last visible control');

  const forwardFromLast = await win.webContents.executeJavaScript(`(() => {
    const next = document.querySelector('#ob-next');
    next.focus();
    next.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    return document.activeElement && document.activeElement.id;
  })()`);
  assert.equal(forwardFromLast, 'ob-back', 'Tab from the last control should wrap to the first visible control');

  await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor(win, "document.querySelector('#onboard-scrim').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'logo-btn'", 'onboarding close and focus restoration');
  const escaped = await win.webContents.executeJavaScript(`({ hidden: document.querySelector('#onboard-scrim').classList.contains('hidden'), active: document.activeElement && document.activeElement.id })`);
  assert.equal(escaped.hidden, true, 'Escape should close onboarding');
  assert.equal(escaped.active, 'logo-btn', 'closing onboarding should restore focus');

  settings.onboarded = false;
  await win.webContents.executeJavaScript("document.querySelector('#logo-btn').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))");
  const modalIsolation = await win.webContents.executeJavaScript(`({ onboardOpen: !document.querySelector('#onboard-scrim').classList.contains('hidden'), settingsOpen: !document.querySelector('#settings-scrim').classList.contains('hidden') })`);
  assert.deepEqual(modalIsolation, { onboardOpen: true, settingsOpen: false }, 'global Settings shortcut must be suppressed while onboarding is open');

  const replayed = await win.webContents.executeJavaScript("document.querySelector('#ob-step-count').textContent");
  assert.match(replayed, /^1 of 11$/, 'reopening the guide from the logo should walk all tutorial topics');
  for (let i = 0; i < 10; i += 1) {
    await win.webContents.executeJavaScript("document.querySelector('#ob-next').click()");
    await waitFor(win, `document.querySelector('#ob-step-count').textContent === '${i + 2} of 11'`, 'replayed guide advance');
  }
  const replayFinal = await win.webContents.executeJavaScript("document.querySelector('#ob-next').textContent");
  assert.equal(replayFinal, 'Done', 'replayed guide should finish with Done rather than Start using Lens');
  await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor(win, "document.querySelector('#onboard-scrim').classList.contains('hidden')", 'onboarding dismissal');

  settings.onboarded = false;
  await win.webContents.executeJavaScript("document.querySelector('#logo-btn').click(); document.querySelector('#ob-next').click()");
  win.setSize(500, 480);
  // Two conditions the old fixed/geometry-sample wait did not prove: the window
  // resize has actually reached the renderer, and the dialog's entry animation
  // has finished. Either one can still be pending on a loaded xvfb runner, and
  // reading geometry before both makes the footer assertion measure the wrong
  // layout (54px single row instead of the 70px compact two-row footer).
  await waitFor(win, 'innerWidth === 500', 'compact viewport width of 500px', FIRST_PAINT_TIMEOUT_MS);
  await waitForEntryAnimation(win, '#onboard', FIRST_PAINT_TIMEOUT_MS);
  const compact = await win.webContents.executeJavaScript(`(() => {
    const footer = document.querySelector('.ob-footer').getBoundingClientRect();
    const dialog = document.querySelector('#onboard').getBoundingClientRect();
    return { overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, footerRight: footer.right, footerHeight: footer.height, dialogRight: dialog.right, width: innerWidth };
  })()`);
  assert.equal(compact.overflowX, false, 'compact onboarding must not overflow horizontally');
  assert.ok(Math.abs(compact.footerHeight - 70) < 0.5, `narrow onboarding should use the compact two-row footer (received ${compact.footerHeight}px)`);
  assert.ok(compact.footerRight <= compact.width && compact.dialogRight <= compact.width, 'compact footer and dialog must fit');
  await capture(win, 'compact');

  await win.webContents.executeJavaScript("document.querySelector('#ob-back').click()");
  await waitFor(win, "document.querySelector('#ob-step-count').textContent === '1 of 11'", 'compact welcome step');
  await waitForEntryAnimation(win, '#onboard', FIRST_PAINT_TIMEOUT_MS);
  const compactWelcome = await win.webContents.executeJavaScript(`(() => {
    const content = document.querySelector('#ob-content');
    const body = document.querySelector('#ob-body').getBoundingClientRect();
    const rect = content.getBoundingClientRect();
    return { overflow: content.scrollHeight > content.clientHeight, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, bodyBottom: body.bottom, contentBottom: rect.bottom, paddingBottom: getComputedStyle(content).paddingBottom };
  })()`);
  assert.equal(compactWelcome.overflow, false, `compact welcome copy must fit without scrolling ${JSON.stringify(compactWelcome)}`);
  assert.ok(compactWelcome.bodyBottom <= compactWelcome.contentBottom + 1, 'compact welcome body must stay inside the content pane');
  await capture(win, 'compact-welcome');

  console.log('Onboarding UI behavior passed: 6 stable steps (including hardware-aware local speech), provider settings pause/resume, focus trap/restoration, modal isolation, and compact layout.');
  await guards.finish(0);
}).catch(async (error) => {
  await guards.finish(1, error);
});
