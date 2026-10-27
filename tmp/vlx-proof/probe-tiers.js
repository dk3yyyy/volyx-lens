'use strict';

// Read-only probe for VR-33: which responsive tier actually applies at the window
// sizes the app can be in, and does the height query ever fire?
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const emptyContext = { count: 0, maxCaptures: null, maxTotalBytes: 96 * 1024 * 1024, totalBytes: 0, pinnedCount: 0, revision: 0 };
const settings = {
  provider: 'openai', fallbackProvider: '', smart: false, onboarded: true, questionDetection: true, assistContext: 'both',
  credentialStatus: { present: {}, secure: true, backend: 'safeStorage' },
  models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }, anthropic: {}, gemini: {}, azure: {}, deepseek: {}, groq: {}, openrouter: {}, ollama: {} },
  endpoints: { azure: '', azureRealtime: '' },
  transcription: { mode: 'realtime', realtimeProvider: 'openai', fallbackModel: 'gpt-4o-mini-transcribe', geminiFallbackModel: 'gemini-3.5-flash', offlineEnabled: false, offlineCloudFallback: false, language: '', delay: 'low' },
  audio: { inputDeviceId: '', micEnabled: true, systemEnabled: true, sensitivity: 'balanced', silenceMs: 700, costWarningMinutes: 30, maxSessionMinutes: 60 },
};

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => Object.assign(settings, patch));
ipcMain.handle('personal-context:get', () => ({ documents: {}, secure: true, locked: false }));
ipcMain.handle('transcript:get', () => []);
ipcMain.handle('task-context:get', () => emptyContext);
ipcMain.handle('history:list', () => []);
ipcMain.handle('history:limits', () => ({ maxRecords: 200, trashRetentionDays: 30, trashCount: 0 }));
ipcMain.handle('recovery:get', () => null);
ipcMain.handle('task-context:list', () => ({ ...emptyContext, captures: [], offset: 0, limit: 50, total: 0 }));
ipcMain.handle('capture:state', () => ({ active: false, transitioning: false }));
ipcMain.handle('shortcuts:get', () => []);
ipcMain.handle('permissions:status', (_e, kind) => ({ kind, status: 'granted', granted: true }));

app.whenReady().then(async () => {
  setTimeout(() => { console.log('PROBE TIMEOUT'); process.exit(2); }, 30000);
  const win = new BrowserWindow({
    width: 700, height: 600, show: false,
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 800));

  for (const [width, height] of [[700, 600], [700, 480], [600, 480], [560, 480], [500, 480], [466, 480]]) {
    win.setSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const report = await win.webContents.executeJavaScript(`(() => {
      const nav = document.querySelector('.s-nav');
      const subtitle = nav.querySelector('span');
      return {
        innerWidth, innerHeight,
        compact560: matchMedia('(max-width: 560px)').matches,
        heightQuery: matchMedia('(max-height: 520px) and (min-width: 561px)').matches,
        navDirection: getComputedStyle(nav).flexDirection,
        subtitleDisplay: getComputedStyle(subtitle).display,
        navOverflow: nav.scrollWidth - nav.clientWidth,
      };
    })()`);
    console.log(JSON.stringify({ requested: [width, height], ...report }));
  }

  // What the renderer thinks the four provider columns need.
  const tabs = await win.webContents.executeJavaScript(`(() => {
    const seg = document.querySelector('#provider-seg');
    return { columns: getComputedStyle(seg).gridTemplateColumns, width: seg.clientWidth };
  })()`);
  console.log(JSON.stringify({ providerTabs: tabs }));
  process.exit(0);
}).catch((error) => { console.error('PROBE ERROR', error); process.exit(1); });
