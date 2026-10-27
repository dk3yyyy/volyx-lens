const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const screenshotDir = process.env.VOLYX_LENS_SETTINGS_SCREENSHOT_DIR || '';
const { STT_MODELS } = require('../src/provider-config');
const settings = {
  provider: 'azure', fallbackProvider: 'openai', smart: true, onboarded: true, questionDetection: true, assistContext: 'both',
  credentialStatus: { present: { azure: true }, secure: true, backend: 'safeStorage' },
  models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }, anthropic: { fast: '', smart: '' }, gemini: { fast: '', smart: '' }, azure: { fast: 'gpt-5.6-sol', smart: 'gpt-5.6-sol' }, deepseek: { fast: '', smart: '' }, groq: { fast: '', smart: '' }, openrouter: { fast: '', smart: '' }, ollama: { fast: '', smart: '' } },
  endpoints: { azure: 'https://resource.openai.azure.com/openai/v1', azureRealtime: '' },
  transcription: { mode: 'realtime', realtimeProvider: 'azure', azureRealtimeDeployment: STT_MODELS.realtime, fallbackModel: STT_MODELS.openaiFallback, geminiFallbackModel: STT_MODELS.geminiFallback, offlineEnabled: false, offlineCloudFallback: false, language: '', delay: 'low' },
  audio: { inputDeviceId: '', micEnabled: true, systemEnabled: true, sensitivity: 'balanced', silenceMs: 700, costWarningMinutes: 30, maxSessionMinutes: 60 }
};
const personalContext = { documents: { resume: { present: false, enabled: false }, jobDescription: { present: false, enabled: false } }, secure: true, locked: false };
const emptyTaskContext = { count: 0, totalBytes: 0, pinnedCount: 0, revision: 0 };

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_event, patch) => Object.assign(settings, patch));
ipcMain.handle('personal-context:get', () => personalContext);
ipcMain.handle('transcript:get', () => []);
ipcMain.handle('task-context:get', () => emptyTaskContext);
// The renderer fetches history on boot; a stub keeps the run free of
// "No handler registered" noise that can mask a real error.
ipcMain.handle('history:list', () => []);
ipcMain.handle('history:limits', () => ({ maxRecords: 200, trashRetentionDays: 30, trashCount: 0 }));
ipcMain.handle('recovery:get', () => recoveryDraft);
ipcMain.handle('recovery:discard', () => ({ cleared: true }));
ipcMain.handle('task-context:list', () => ({ ...emptyTaskContext, captures: [], offset: 0, limit: 50, total: 0 }));
ipcMain.handle('capture:state', () => ({ active: false }));
ipcMain.handle('permissions:request', (_event, kind) => ({
  kind,
  granted: false,
  status: 'denied',
  settingsOpened: false, requiresSettings: true,
  developmentClient: true,
  message: 'This npm start development build is a separate macOS permission client. Quit it and open the packaged app; a grant for Volyx Lens.app does not apply to this process.',
}));
ipcMain.handle('update:get-state', () => ({ supported: false, currentVersion: '0.2.0', status: 'unsupported', message: 'Updates are available in official signed macOS release builds.', availableVersion: null, progress: null }));
ipcMain.handle('shortcuts:get', () => [
  { id: 'assist', feature: 'Assist', displayAccelerator: '⌘↵', registered: true },
  { id: 'solve', feature: 'Solve screen', displayAccelerator: '⌘H', registered: true },
  { id: 'task-context', feature: 'Add screen', displayAccelerator: '⌘⇧C', registered: true },
  { id: 'quit', feature: 'Stop all and quit', displayAccelerator: '⌘⇧X', registered: true }
]);
ipcMain.on('mouse:ignore', () => {});
const modalReports = [];
ipcMain.on('ui:modal-state', (_event, open) => { modalReports.push(open === true); });
let recoveryDraft = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(win, expression, message, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${message}`);
}
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
  await waitFor(win, "!document.querySelector('#settings-scrim').classList.contains('hidden')", 'Settings to open');

  const sections = ['providers', 'listening', 'context', 'shortcuts', 'updates'];
  const heights = new Set();
  for (const section of sections) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-settings-section="${section}"]').click()`);
    await waitFor(win, `document.activeElement && document.activeElement.id === 'settings-${section}-title'`, `${section} heading focus`);
    await wait(60); // Allow Chromium to paint the already-verified section before screenshot capture.
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

  await win.webContents.executeJavaScript("document.querySelector('[data-settings-section=\"listening\"]').click(); document.querySelector('#test-live-transcription-btn').click()");
  await waitFor(win, "document.querySelector('#realtime-test-result').textContent.includes('permission_client_mismatch')", 'development permission identity guidance');
  const permissionDiagnostic = await win.webContents.executeJavaScript(`({
    text: document.querySelector('#realtime-test-result').textContent,
    startAttempted: document.querySelector('#test-live-transcription-btn').textContent !== 'Test Live Mic'
  })`);
  assert.match(permissionDiagnostic.text, /npm start/i, 'development diagnostic should name the active npm start client');
  assert.match(permissionDiagnostic.text, /packaged app/i, 'development diagnostic should direct users to the packaged app');
  assert.equal(permissionDiagnostic.startAttempted, false, 'development mismatch should stop before opening microphone capture');

  await win.webContents.executeJavaScript("document.querySelector('[data-settings-section=\"shortcuts\"]').click()");
  await waitFor(win, "document.activeElement && document.activeElement.id === 'settings-shortcuts-title'", 'shortcuts heading focus before reverse tab test');
  const reverseFromHeading = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#settings-shortcuts-title').focus();
    document.querySelector('#settings-shortcuts-title').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    return document.activeElement && (document.activeElement.id || document.activeElement.dataset.shortcutFallback);
  })()`);
  assert.equal(reverseFromHeading, 'quit', 'Shift+Tab from heading should wrap to the final visible control');

  // Every section switch must move aria-current with it and keep the button wired to
  // the page it shows: a class-only "on" state told a screen reader nothing (VR-32).
  for (const section of ['listening', 'context', 'shortcuts', 'providers']) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-settings-section="${section}"]').click()`);
    await waitFor(win, `document.querySelector('[data-settings-page="${section}"]').classList.contains('on')`, `${section} page`);
    const semantics = await win.webContents.executeJavaScript(`(() => {
      const current = [...document.querySelectorAll('[data-settings-section][aria-current="page"]')];
      const visible = [...document.querySelectorAll('[data-settings-page]')].filter((page) => !page.hidden);
      const controlled = current.map((button) => button.getAttribute('aria-controls'));
      return {
        currentCount: current.length,
        currentSection: current[0] ? current[0].dataset.settingsSection : null,
        controlledIds: controlled,
        visibleIds: visible.map((page) => page.id),
        visibleLabelledBy: visible.map((page) => page.getAttribute('aria-labelledby')),
        visibleTitleIds: visible.map((page) => { const h2 = page.querySelector('h2'); return h2 ? h2.id : null; }),
      };
    })()`);
    assert.equal(semantics.currentCount, 1, `exactly one section is current for ${section}`);
    assert.equal(semantics.currentSection, section);
    assert.equal(semantics.visibleIds.length, 1, 'exactly one page is shown');
    assert.equal(semantics.controlledIds[0], semantics.visibleIds[0], 'aria-controls points at the visible page');
    assert.equal(semantics.visibleLabelledBy[0], semantics.visibleTitleIds[0], 'the page is named by its own heading');
  }

  // The provider tabs must report the same selection the panel shows.
  const providerSemantics = await win.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('#provider-seg [role="tab"]')];
    const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
    const panel = document.querySelector('#provider-config-panel');
    return {
      total: tabs.length,
      selected: selected.length,
      selectedControlsPanel: selected[0] ? selected[0].getAttribute('aria-controls') === panel.id : false,
      panelLabelledBy: panel.getAttribute('aria-labelledby'),
      selectedId: selected[0] ? selected[0].id : null,
      roving: tabs.filter((tab) => tab.tabIndex === 0).length,
    };
  })()`);
  assert.equal(providerSemantics.total, 9, 'all providers are exposed as tabs');
  assert.equal(providerSemantics.selected, 1, 'exactly one provider tab is selected');
  assert.equal(providerSemantics.roving, 1, 'one tab is in the tab order');
  assert.equal(providerSemantics.selectedControlsPanel, true, 'the selected tab controls the visible panel');
  assert.equal(providerSemantics.panelLabelledBy, providerSemantics.selectedId, 'the panel is named by the selected tab');

  await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor(win, "document.querySelector('#settings-scrim').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'more-btn'", 'Settings close and focus restoration');
  const closed = await win.webContents.executeJavaScript(`({ hidden: document.querySelector('#settings-scrim').classList.contains('hidden'), active: document.activeElement && document.activeElement.id })`);
  assert.equal(closed.hidden, true, 'Escape should close Settings');
  assert.equal(closed.active, 'more-btn', 'closing Settings should restore focus');

  await win.webContents.executeJavaScript("document.querySelector('#more-btn').click()");
  await waitFor(win, "!document.querySelector('#settings-scrim').classList.contains('hidden')", 'Settings to reopen');
  win.setSize(500, 480);
  await waitFor(win, 'innerWidth === 500', 'compact viewport');
  const compact = await win.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#settings').getBoundingClientRect();
    return { overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth, dialogRight: dialog.right, width: innerWidth };
  })()`);
  assert.equal(compact.overflowX, false, 'compact Settings must not overflow horizontally');
  assert.ok(compact.dialogRight <= compact.width, 'compact Settings dialog must fit');
  await capture(win, 'compact');

  recoveryDraft = { turnCount: 500, totalTurns: 620, truncated: 120, clippedTurns: 2, startedAt: Date.now() - 60000, updatedAt: Date.now() };
  win.reload();
  await waitFor(win, "document.querySelector('#meeting-recovery-dialog').open === true", 'meeting recovery dialog to open after reload', 5000);
  const recoverySummary = await win.webContents.executeJavaScript("document.querySelector('#meeting-recovery-summary').textContent");
  assert.equal(modalReports[modalReports.length - 1], true, 'recovery dialog should report an open modal');
  assert.match(recoverySummary, /500 transcript turns from .+ can be recovered\./, 'recovery summary should describe the restored draft');
  assert.match(recoverySummary, /earliest 120 turns were not saved/, 'recovery summary should disclose dropped turns');
  assert.match(recoverySummary, /2 long turns were shortened/, 'recovery summary should disclose shortened turns');
  await win.webContents.executeJavaScript("document.querySelector('#meeting-recovery-discard').click()");
  await waitFor(win, "document.querySelector('#meeting-recovery-dialog').open === false", 'recovery dialog to close after discard');
  await wait(50);
  assert.equal(modalReports[modalReports.length - 1], false, 'closing the recovery dialog should clear modal state');

  console.log('Settings UI behavior passed: 5 simple pages, stable layout, focus containment/restoration, compact fit, and recovery dialog modal state.');
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
