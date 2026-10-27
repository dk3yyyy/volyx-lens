const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const screenshotDir = process.env.VOLYX_LENS_E2E_SCREENSHOT_DIR || '';
const consoleErrors = [];
const consoleWarnings = [];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(win, expression, message, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    } catch {
      // Renderer not ready yet — keep polling.
    }
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function captureScreenshot(win, name) {
  if (!screenshotDir) return null;
  fs.mkdirSync(screenshotDir, { recursive: true });
  const image = await win.webContents.capturePage();
  const filePath = path.join(screenshotDir, `${name}.png`);
  fs.writeFileSync(filePath, image.toPNG());
  return filePath;
}

// Stub IPC handlers so the renderer can complete boot without the full
// main.js pipeline (we only test that the preload bridge initializes).
const settings = {
  provider: 'openai',
  fallbackProvider: '',
  smart: false,
  onboarded: false,
  questionDetection: true,
  assistContext: 'both',
  credentialStatus: { present: {}, secure: true, backend: 'safeStorage' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: {},
    gemini: {},
    azure: {},
    deepseek: {},
    groq: {},
    openrouter: {},
    ollama: {},
  },
  endpoints: { azure: '', azureRealtime: '' },
  transcription: {
    mode: 'realtime',
    realtimeProvider: 'openai',
    fallbackModel: 'gpt-4o-mini-transcribe',
    geminiFallbackModel: 'gemini-3.5-flash',
    offlineEnabled: false,
    offlineCloudFallback: false,
    language: '',
    delay: 'low',
  },
  audio: {
    inputDeviceId: '',
    micEnabled: true,
    systemEnabled: true,
    sensitivity: 'balanced',
    silenceMs: 700,
    costWarningMinutes: 30,
    maxSessionMinutes: 60,
  },
};
const emptyContext = {
  count: 0,
  maxCaptures: null,
  maxTotalBytes: 96 * 1024 * 1024,
  totalBytes: 0,
  pinnedCount: 0,
  revision: 0,
};

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_event, patch) => Object.assign(settings, patch));
ipcMain.handle('personal-context:get', () => ({ documents: {}, secure: true, locked: false }));
ipcMain.handle('transcript:get', () => []);
ipcMain.handle('task-context:get', () => emptyContext);
ipcMain.handle('recovery:get', () => null);
ipcMain.handle('task-context:list', () => ({ ...emptyContext, captures: [], offset: 0, limit: 50, total: 0 }));
ipcMain.handle('capture:state', () => ({ active: false, transitioning: false }));
ipcMain.handle('shortcuts:get', () => []);
ipcMain.handle('history:list', () => []);
ipcMain.handle('history:limits', () => ({ maxRecords: 200, trashRetentionDays: 30, trashCount: 0 }));
ipcMain.handle('permissions:status', (_event, kind) => ({ kind, status: 'not-determined', granted: false }));
ipcMain.handle('permissions:request', (_event, kind) => (
  kind === 'screen'
    ? { kind, granted: false, settingsOpened: true, developmentClient: false }
    : { kind, granted: true }
));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800,
    height: 700,
    show: false,
    backgroundColor: '#151827',
    webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Collect console errors and warnings for later assertions.
  win.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) {
      consoleErrors.push(message);
    } else if (level === 2) {
      consoleWarnings.push(message);
    }
  });

  // Also capture uncaught renderer exceptions.
  win.webContents.on('render-process-gone', (_event, details) => {
    consoleErrors.push(`Renderer gone: ${details.reason}`);
  });
  win.webContents.on('unresponsive', () => {
    consoleErrors.push('Renderer became unresponsive');
  });

  try {
    await win.loadFile(path.join(root, 'renderer', 'index.html'));

    // 1. Main window created and visible.
    assert.ok(win, 'Main window should exist');
    assert.ok(!win.isDestroyed(), 'Main window should not be destroyed after load');

    // 2. Renderer HTML loaded — #app element present.
    await waitFor(win, "document.querySelector('#app')", 'app root element');

    // 3. Preload bridge exposed: window.volyxLens exists and has the expected API surface.
    await waitFor(win, 'window.volyxLens', 'preload bridge (window.volyxLens)');

    const apiSurface = await win.webContents.executeJavaScript(`(() => {
      const v = window.volyxLens;
      if (!v) return null;
      return {
        hasSettingsGet: typeof v.settingsGet === 'function',
        hasSettingsSet: typeof v.settingsSet === 'function',
        hasCaptureToggle: typeof v.captureToggle === 'function',
        hasCaptureState: typeof v.captureState === 'function',
        hasNewSession: typeof v.newSession === 'function',
        hasTranscriptGet: typeof v.transcriptGet === 'function',
        hasRecoveryGet: typeof v.recoveryGet === 'function',
        hasRecoveryRestore: typeof v.recoveryRestore === 'function',
        hasRecoveryDiscard: typeof v.recoveryDiscard === 'function',
        hasAsk: typeof v.ask === 'function',
        hasCancelResponse: typeof v.cancelResponse === 'function',
        hasOn: typeof v.on === 'function',
        hasRendererReady: typeof v.rendererReady === 'function',
        hasQuit: typeof v.quit === 'function',
        hasRelaunch: typeof v.relaunch === 'function',
        hasLog: typeof v.log === 'function',
        hasPlatform: typeof v.platform === 'string',
        hasAudioConfig: v.audioConfig && typeof v.audioConfig.sampleRate === 'number',
      };
    })()`);

    assert.ok(apiSurface, 'window.volyxLens should expose an API surface');
    assert.equal(apiSurface.hasSettingsGet, true, 'settingsGet should be exposed');
    assert.equal(apiSurface.hasSettingsSet, true, 'settingsSet should be exposed');
    assert.equal(apiSurface.hasCaptureToggle, true, 'captureToggle should be exposed');
    assert.equal(apiSurface.hasCaptureState, true, 'captureState should be exposed');
    assert.equal(apiSurface.hasNewSession, true, 'newSession should be exposed');
    assert.equal(apiSurface.hasTranscriptGet, true, 'transcriptGet should be exposed');
    assert.equal(apiSurface.hasRecoveryGet, true, 'recoveryGet should be exposed');
    assert.equal(apiSurface.hasRecoveryRestore, true, 'recoveryRestore should be exposed');
    assert.equal(apiSurface.hasRecoveryDiscard, true, 'recoveryDiscard should be exposed');
    assert.equal(apiSurface.hasAsk, true, 'ask should be exposed');
    assert.equal(apiSurface.hasCancelResponse, true, 'cancelResponse should be exposed');
    assert.equal(apiSurface.hasOn, true, 'on should be exposed');
    assert.equal(apiSurface.hasRendererReady, true, 'rendererReady should be exposed');
    assert.equal(apiSurface.hasQuit, true, 'quit should be exposed');
    assert.equal(apiSurface.hasRelaunch, true, 'relaunch should be exposed');
    assert.equal(apiSurface.hasLog, true, 'log should be exposed');
    assert.equal(apiSurface.hasPlatform, true, 'platform should be exposed');
    assert.equal(apiSurface.hasAudioConfig, true, 'audioConfig.sampleRate should be exposed');

    // 4. Renderer bootstrapped without throwing — toolbar icons painted and boot resolved.
    await waitFor(win, 'document.querySelector("#logo-btn")?.innerHTML?.length > 0', 'toolbar logo painted');

    const toolbarPainted = await win.webContents.executeJavaScript(`(() => {
      const logo = document.querySelector('#logo-btn');
      const hideBtn = document.querySelector('#hide-btn');
      const stopBtn = document.querySelector('#stop-btn');
      return logo && hideBtn && stopBtn
        && logo.innerHTML.length > 0
        && hideBtn.querySelector('.chev')?.innerHTML.length > 0;
    })()`);
    assert.equal(toolbarPainted, true, 'Toolbar icons should be painted by renderer.js');

    // 5. Renderer completed its boot sequence and reported ready.
    const rendererReady = await waitFor(win, 'window.__volyxLensBootDone === true', 'renderer boot done')
      .then(() => true)
      .catch(() => false);

    // If the renderer didn't self-report, check the boot function ran without throwing.
    if (!rendererReady) {
      const bootState = await win.webContents.executeJavaScript(`(() => {
        const app = document.querySelector('#app');
        const toolbar = document.querySelector('#toolbar');
        const panel = document.querySelector('#panel');
        return {
          hasToolbar: !!toolbar,
          hasPanel: !!panel,
          toolbarButtons: toolbar ? toolbar.querySelectorAll('button').length : 0,
          panelChildren: panel ? panel.children.length : 0,
        };
      })()`);
      assert.ok(bootState.hasToolbar && bootState.hasPanel, 'Boot should render toolbar and panel');
      assert.ok(bootState.toolbarButtons >= 5, 'Toolbar should have multiple buttons');
      assert.ok(bootState.panelChildren >= 3, 'Panel should render its children');
    }

    // 5b. Clearing the transcript mid-stream must not wedge the composer. The
    // main process owns the run, the renderer owns the busy state, and a silent
    // invalidation used to leave the buttons disabled with an orphaned answer.
    win.webContents.send('llm:start', { mode: 'assist' });
    win.webContents.send('llm:token', { text: 'Half an answer' });
    await waitFor(win, "document.querySelector('.ai-text') && !document.querySelector('#cancel-response').classList.contains('hidden')", 'streaming state');
    win.webContents.send('llm:canceled', { reason: 'transcript-clear' });
    win.webContents.send('transcript:cleared', {});
    await waitFor(win, "!document.querySelector('.ai-text')", 'the orphaned answer is gone');
    const afterClear = await win.webContents.executeJavaScript(`(() => {
      const cancel = document.querySelector('#cancel-response');
      const actions = [...document.querySelectorAll('.act[data-mode]')];
      return {
        cancelHidden: cancel.classList.contains('hidden'),
        anyDisabled: actions.some((button) => button.disabled),
        answers: document.querySelectorAll('.ai-text').length,
      };
    })()`);
    assert.equal(afterClear.cancelHidden, true, 'Cancel should hide once the run ends');
    assert.equal(afterClear.anyDisabled, false, 'Action buttons should be usable again');
    assert.equal(afterClear.answers, 0, 'The answer about a cleared transcript should be removed');

    // 5c. A provider error after tokens have arrived keeps the answer instead of
    // overwriting it with the error string (VR-11).
    win.webContents.send('llm:start', { mode: 'assist' });
    win.webContents.send('llm:token', { text: 'The answer that already arrived' });
    await waitFor(win, "document.querySelector('.ai-text') && document.querySelector('.ai-text').textContent.includes('already arrived')", 'the streamed answer');
    win.webContents.send('llm:error', { message: 'The provider dropped the connection.' });
    await waitFor(win, "document.querySelector('.ai-error')", 'the error block');
    const afterProviderError = await win.webContents.executeJavaScript(`(() => {
      const answers = [...document.querySelectorAll('.ai-text')];
      const block = document.querySelector('.ai-error');
      return {
        answers: answers.length,
        answerText: answers.map((node) => node.textContent).join(' '),
        errorText: block ? block.textContent : '',
        retry: !!document.querySelector('.ai-error .ai-retry'),
        busy: document.querySelector('#send-btn').classList.contains('busy'),
      };
    })()`);
    assert.equal(afterProviderError.answers, 1, 'the partial answer is still there');
    assert.match(afterProviderError.answerText, /already arrived/, 'the streamed text was not overwritten');
    assert.match(afterProviderError.errorText, /dropped the connection/, 'the failure is shown separately');
    // No request was dispatched in this scenario, so there is nothing to retry and
    // the button is correctly absent; the retry path is pinned by a unit test.
    assert.equal(afterProviderError.retry, false, 'no retry without a known request');
    assert.equal(afterProviderError.busy, false, 'the composer is usable again');

    // 5d. Both scrollers must show a thumb at rest: on Windows a hidden thumb read
    // as a truncated answer rather than a scrollable one (VR-35).
    const scrollAffordance = await win.webContents.executeJavaScript(`(() => {
      const read = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const style = getComputedStyle(el);
        return { color: style.scrollbarColor || '', gutter: style.scrollbarGutter || '', overflowY: style.overflowY };
      };
      return { panel: read('#panel'), messages: read('#messages') };
    })()`);
    for (const [name, value] of Object.entries(scrollAffordance)) {
      assert.ok(value, `${name} exists`);
      assert.doesNotMatch(value.color, /^transparent/i, `${name} must not hide its scrollbar at rest (got "${value.color}")`);
      assert.equal(value.gutter, 'stable', `${name} must reserve its scrollbar gutter`);
      assert.equal(value.overflowY, 'auto', `${name} scrolls`);
    }

    // 6. No console errors during boot.
    if (consoleErrors.length > 0) {
      console.error('Console errors captured during E2E boot:');
      for (const err of consoleErrors) console.error('  -', err);
    }
    assert.equal(consoleErrors.length, 0, `No console errors should appear during boot (got ${consoleErrors.length})`);

    // 7. Screenshot for visual verification.
    const screenshotPath = await captureScreenshot(win, 'e2e-smoke');
    if (screenshotPath) {
      console.log(`E2E screenshot saved: ${screenshotPath}`);
    }

    console.log('E2E smoke test passed: window created, preload bridge exposed, renderer painted, no console errors.');
    app.quit();
  } catch (error) {
    console.error('E2E smoke test failed:', error.message);
    try {
      await captureScreenshot(win, 'e2e-smoke-failure');
    } catch {
      // Ignore screenshot errors during failure handling.
    }
    app.exit(1);
  }
}).catch((error) => {
  console.error('E2E smoke test crashed:', error);
  app.exit(1);
});

// Safety timeout — if the app hangs, fail fast.
setTimeout(() => {
  console.error('E2E smoke test timed out after 60s');
  app.exit(1);
}, 60000);
