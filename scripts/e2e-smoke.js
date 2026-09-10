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
ipcMain.handle('task-context:list', () => ({ ...emptyContext, captures: [], offset: 0, limit: 50, total: 0 }));
ipcMain.handle('capture:state', () => ({ active: false, transitioning: false }));
ipcMain.handle('shortcuts:get', () => []);
ipcMain.handle('history:list', () => []);
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
