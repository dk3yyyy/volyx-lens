const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const screenshotDir = process.env.VOLYX_LENS_SETTINGS_SCREENSHOT_DIR || '';
const settings = {
  provider: 'azure', fallbackProvider: 'openai', smart: true, onboarded: true, questionDetection: true, assistContext: 'both',
  credentialStatus: { present: { azure: true }, secure: true, backend: 'safeStorage' },
  models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }, anthropic: { fast: '', smart: '' }, gemini: { fast: '', smart: '' }, azure: { fast: 'gpt-5.6-sol', smart: 'gpt-5.6-sol' }, deepseek: { fast: '', smart: '' } },
  endpoints: { azure: 'https://resource.openai.azure.com/openai/v1', azureRealtime: '' },
  transcription: { mode: 'realtime', realtimeProvider: 'azure', azureRealtimeDeployment: 'gpt-realtime-whisper', fallbackModel: 'gpt-4o-mini-transcribe', offlineEnabled: false, offlineCloudFallback: false, language: '', delay: 'low' },
  audio: { inputDeviceId: '', micEnabled: true, systemEnabled: true, sensitivity: 'balanced', silenceMs: 700, costWarningMinutes: 30, maxSessionMinutes: 60 }
};
const personalContext = { documents: { resume: { present: false, enabled: false }, jobDescription: { present: false, enabled: false } }, secure: true, locked: false };
const emptyTaskContext = { count: 0, totalBytes: 0, pinnedCount: 0, revision: 0 };

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_event, patch) => Object.assign(settings, patch));
ipcMain.handle('personal-context:get', () => personalContext);
ipcMain.handle('transcript:get', () => []);
ipcMain.handle('task-context:get', () => emptyTaskContext);
ipcMain.handle('task-context:list', () => ({ ...emptyTaskContext, captures: [], offset: 0, limit: 50, total: 0 }));
ipcMain.handle('capture:state', () => ({ active: false }));
ipcMain.handle('shortcuts:get', () => [
  { id: 'assist', feature: 'Assist', displayAccelerator: '⌘↵', registered: true },
  { id: 'solve', feature: 'Solve screen', displayAccelerator: '⌘H', registered: true },
  { id: 'task-context', feature: 'Add screen', displayAccelerator: '⌘⇧C', registered: true },
  { id: 'quit', feature: 'Stop all and quit', displayAccelerator: '⌘⇧X', registered: true }
]);
ipcMain.on('mouse:ignore', () => {});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function capture(win, name) {
  if (!screenshotDir) return;
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.writeFileSync(path.join(screenshotDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 700, height: 600, minWidth: 500, minHeight: 480, show: false,
    backgroundColor: '#151827',
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  win.show();
  await wait(450);
  await win.webContents.executeJavaScript("document.querySelector('#more-btn').click()");
  await wait(350);

  const sections = ['providers', 'listening', 'context', 'shortcuts'];
  const heights = new Set();
  for (const section of sections) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-settings-section="${section}"]').click()`);
    await wait(60);
    const state = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('#settings').getBoundingClientRect();
      const visible = [...document.querySelectorAll('[data-settings-page]')].filter((page) => !page.hidden);
      return {
        active: document.activeElement && document.activeElement.id,
        selected: document.querySelector('[data-settings-section].on').dataset.settingsSection,
        visible: visible.map((page) => page.dataset.settingsPage),
        dialog: { x: dialog.x, y: dialog.y, right: dialog.right, bottom: dialog.bottom, width: dialog.width, height: dialog.height },
        viewport: { width: innerWidth, height: innerHeight },
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    assert.equal(state.selected, section, `${section} navigation should be selected`);
    assert.deepEqual(state.visible, [section], `${section} should be the only visible page`);
    assert.equal(state.active, `settings-${section}-title`, `${section} heading should receive focus`);
    assert.equal(state.overflowX, false, `${section} must not overflow horizontally`);
    assert.ok(state.dialog.x >= 0 && state.dialog.y >= 0 && state.dialog.right <= state.viewport.width && state.dialog.bottom <= state.viewport.height, `${section} dialog must fit viewport`);
    heights.add(state.dialog.height);
    await capture(win, section);
  }
  assert.equal(heights.size, 1, 'settings shell height should remain stable');

  const reverseFromHeading = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#settings-shortcuts-title').focus();
    document.querySelector('#settings-shortcuts-title').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    return document.activeElement && (document.activeElement.id || document.activeElement.dataset.shortcutFallback);
  })()`);
  assert.equal(reverseFromHeading, 'quit', 'Shift+Tab from heading should wrap to the final visible control');

  await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await wait(80);
  const closed = await win.webContents.executeJavaScript(`({ hidden: document.querySelector('#settings-scrim').classList.contains('hidden'), active: document.activeElement && document.activeElement.id })`);
  assert.equal(closed.hidden, true, 'Escape should close Settings');
  assert.equal(closed.active, 'more-btn', 'closing Settings should restore focus');

  await win.webContents.executeJavaScript("document.querySelector('#more-btn').click()");
  await wait(100);
  win.setSize(500, 480);
  await wait(120);
  const compact = await win.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#settings').getBoundingClientRect();
    return { overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, dialogRight: dialog.right, width: innerWidth };
  })()`);
  assert.equal(compact.overflowX, false, 'compact Settings must not overflow horizontally');
  assert.ok(compact.dialogRight <= compact.width, 'compact Settings dialog must fit');
  await capture(win, 'compact');

  console.log('Settings UI behavior passed: 4 simple pages, stable layout, focus containment/restoration, and compact fit.');
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
