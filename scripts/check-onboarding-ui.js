const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const screenshotDir = process.env.VOLYX_LENS_ONBOARDING_SCREENSHOT_DIR || '';
const emptyContext = { count: 0, maxCaptures: null, maxTotalBytes: 96 * 1024 * 1024, totalBytes: 0, pinnedCount: 0, revision: 0 };
const settings = {
  provider: 'openai', fallbackProvider: '', smart: false, onboarded: false, questionDetection: true, assistContext: 'both',
  credentialStatus: { present: {}, secure: true, backend: 'safeStorage' },
  models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }, anthropic: {}, gemini: {}, azure: {}, deepseek: {} },
  endpoints: { azure: '', azureRealtime: '' },
  transcription: { mode: 'realtime', realtimeProvider: 'openai', fallbackModel: 'gpt-4o-mini-transcribe', offlineEnabled: false, offlineCloudFallback: false, language: '', delay: 'low' },
  audio: { inputDeviceId: '', micEnabled: true, systemEnabled: true, sensitivity: 'balanced', silenceMs: 700, costWarningMinutes: 30, maxSessionMinutes: 60 }
};

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_event, patch) => Object.assign(settings, patch));
ipcMain.handle('personal-context:get', () => ({ documents: {}, secure: true, locked: false }));
ipcMain.handle('transcript:get', () => []);
ipcMain.handle('task-context:get', () => emptyContext);
ipcMain.handle('task-context:list', () => ({ ...emptyContext, captures: [], offset: 0, limit: 50, total: 0 }));
ipcMain.handle('capture:state', () => ({ active: false, transitioning: false }));
ipcMain.handle('shortcuts:get', () => []);
ipcMain.handle('permissions:request', (_event, kind) => ({ kind, granted: true }));
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
  await wait(500);

  const names = ['welcome', 'permissions', 'provider', 'sharing', 'ready'];
  const heights = new Set();
  for (let index = 0; index < names.length; index += 1) {
    const state = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('#onboard').getBoundingClientRect();
      const content = document.querySelector('#ob-content');
      return {
        active: document.activeElement && document.activeElement.id,
        dialog: { x: dialog.x, y: dialog.y, width: dialog.width, height: dialog.height, right: dialog.right, bottom: dialog.bottom },
        viewport: { width: innerWidth, height: innerHeight },
        contentOverflowY: content.scrollHeight > content.clientHeight,
        documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    assert.equal(state.active, 'ob-title', `${names[index]} should focus its heading`);
    assert.equal(state.documentOverflowX, false, `${names[index]} must not overflow horizontally`);
    assert.equal(state.contentOverflowY, false, `${names[index]} must not scroll at production size`);
    assert.ok(state.dialog.x >= 0 && state.dialog.y >= 0 && state.dialog.right <= state.viewport.width && state.dialog.bottom <= state.viewport.height, `${names[index]} dialog must fit viewport`);
    heights.add(state.dialog.height);
    await capture(win, names[index]);
    if (index < names.length - 1) {
      await win.webContents.executeJavaScript("document.querySelector('#ob-next').click()");
      await wait(80);
    }
  }
  assert.equal(heights.size, 1, 'all onboarding steps should keep a stable shell height');

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
  await wait(40);
  const escaped = await win.webContents.executeJavaScript(`({ hidden: document.querySelector('#onboard-scrim').classList.contains('hidden'), active: document.activeElement && document.activeElement.id })`);
  assert.equal(escaped.hidden, true, 'Escape should close onboarding');
  assert.equal(escaped.active, 'logo-btn', 'closing onboarding should restore focus');

  settings.onboarded = false;
  await win.webContents.executeJavaScript("document.querySelector('#logo-btn').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))");
  const modalIsolation = await win.webContents.executeJavaScript(`({ onboardOpen: !document.querySelector('#onboard-scrim').classList.contains('hidden'), settingsOpen: !document.querySelector('#settings-scrim').classList.contains('hidden') })`);
  assert.deepEqual(modalIsolation, { onboardOpen: true, settingsOpen: false }, 'global Settings shortcut must be suppressed while onboarding is open');
  await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await wait(40);

  settings.onboarded = false;
  await win.webContents.executeJavaScript("document.querySelector('#logo-btn').click(); document.querySelector('#ob-next').click()");
  win.setSize(500, 480);
  await wait(100);
  const compact = await win.webContents.executeJavaScript(`(() => {
    const footer = document.querySelector('.ob-footer').getBoundingClientRect();
    const dialog = document.querySelector('#onboard').getBoundingClientRect();
    return { overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, footerRight: footer.right, dialogRight: dialog.right, width: innerWidth };
  })()`);
  assert.equal(compact.overflowX, false, 'compact onboarding must not overflow horizontally');
  assert.ok(compact.footerRight <= compact.width && compact.dialogRight <= compact.width, 'compact footer and dialog must fit');
  await capture(win, 'compact');

  console.log('Onboarding UI behavior passed: 5 stable steps, focus trap/restoration, modal isolation, and compact layout.');
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
