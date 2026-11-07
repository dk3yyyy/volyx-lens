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
  waitForPaint,
  waitForRendererReady,
} = require('./ui-harness-helpers');

const root = path.join(__dirname, '..');
const screenshotDir = process.env.VOLYX_LENS_ONBOARDING_SCREENSHOT_DIR || '';
const emptyContext = { count: 0, maxCaptures: null, maxTotalBytes: 96 * 1024 * 1024, totalBytes: 0, pinnedCount: 0, revision: 0 };
const settings = {
  provider: 'openai', fallbackProvider: '', smart: false, onboarded: false, questionDetection: true, assistContext: 'both',
  credentialStatus: { present: {}, secure: true, backend: 'safeStorage' },
  models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }, anthropic: {}, gemini: {}, azure: {}, deepseek: {}, groq: {}, openrouter: {}, ollama: {} },
  endpoints: { azure: '', azureRealtime: '' },
  transcription: { mode: 'realtime', realtimeProvider: 'openai', fallbackModel: 'gpt-4o-mini-transcribe', geminiFallbackModel: 'gemini-3.5-flash', offlineEnabled: false, offlineCloudFallback: false, language: '', delay: 'low' },
  audio: { inputDeviceId: '', micEnabled: true, systemEnabled: true, sensitivity: 'balanced', silenceMs: 700, costWarningMinutes: 30, maxSessionMinutes: 60 }
};

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_event, patch) => Object.assign(settings, patch));
ipcMain.handle('personal-context:get', () => ({ documents: {}, secure: true, locked: false }));
ipcMain.handle('transcript:get', () => []);
ipcMain.handle('task-context:get', () => emptyContext);
// The renderer fetches history and its limits on boot. Stub them so the run has
// no "No handler registered" noise masking a real error.
ipcMain.handle('history:list', () => []);
ipcMain.handle('history:limits', () => ({ maxRecords: 200, trashRetentionDays: 30, trashCount: 0 }));
ipcMain.handle('recovery:get', () => null);
ipcMain.handle('task-context:list', () => ({ ...emptyContext, captures: [], offset: 0, limit: 50, total: 0 }));
ipcMain.handle('capture:state', () => ({ active: false, transitioning: false }));
ipcMain.handle('shortcuts:get', () => []);
let developmentPermissionClient = false;
ipcMain.handle('permissions:request', (_event, kind) => (
  kind === 'screen'
    ? developmentPermissionClient
      ? { kind, granted: false, status: 'denied', settingsOpened: false, requiresSettings: true, developmentClient: true, message: 'This npm start development build is a separate macOS permission client.' }
      : { kind, granted: false, settingsOpened: false, requiresSettings: true, developmentClient: false }
    : { kind, granted: true }
));
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

  const names = ['welcome', 'permissions', 'provider', 'sharing', 'ready'];
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
        documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    assert.equal(state.active, 'ob-title', `${names[index]} should focus its heading`);
    assert.equal(state.documentOverflowX, false, `${names[index]} must not overflow horizontally`);
    assert.equal(state.contentOverflowY, false, `${names[index]} must not scroll at production size`);
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
      await waitFor(win, "document.querySelector('#onboard-scrim').classList.contains('hidden') === false && document.querySelector('#ob-step-count').textContent === '3 of 5'", 'closing settings should resume the guide at the same step');
      const resumed = await win.webContents.executeJavaScript(`({ step: document.querySelector('#ob-step-count').textContent, active: document.activeElement && document.activeElement.id })`);
      assert.equal(resumed.step, '3 of 5', 'guide should resume at the provider step');
    }
    if (index === 1) {
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
    if (index < names.length - 1) {
      await win.webContents.executeJavaScript("document.querySelector('#ob-next').click()");
      await waitFor(win, `document.activeElement && document.activeElement.id === 'ob-title' && document.querySelector('#ob-step-count').textContent === '${index + 2} of 5'`, `${names[index + 1]} heading focus`);
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
  assert.match(replayed, /^1 of 10$/, 'reopening the guide from the logo should walk all tutorial topics');
  for (let i = 0; i < 9; i += 1) {
    await win.webContents.executeJavaScript("document.querySelector('#ob-next').click()");
    await waitFor(win, `document.querySelector('#ob-step-count').textContent === '${i + 2} of 10'`, 'replayed guide advance');
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
  await waitFor(win, "document.querySelector('#ob-step-count').textContent === '1 of 10'", 'compact welcome step');
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

  console.log('Onboarding UI behavior passed: 5 stable steps, provider settings pause/resume, focus trap/restoration, modal isolation, and compact layout.');
  await guards.finish(0);
}).catch(async (error) => {
  await guards.finish(1, error);
});
