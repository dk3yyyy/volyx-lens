const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FIRST_PAINT_TIMEOUT_MS,
  installHarnessGuards,
  trackRendererConsole,
  waitFor,
  waitForHost,
  waitForPaint,
  waitForRendererReady,
} = require('./ui-harness-helpers');

const root = path.join(__dirname, '..');
const requestedTheme = process.env.VOLYX_LENS_ACCENT_THEME;
const accentTheme = ['indigo', 'sage', 'ember'].includes(requestedTheme) ? requestedTheme : 'indigo';
const screenshotDir = process.env.VOLYX_LENS_SETTINGS_SCREENSHOT_DIR || '';
const { STT_MODELS } = require('../src/provider-config');
const settings = {
  appearance: { theme: accentTheme },
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
ipcMain.handle('update:get-state', () => ({ supported: false, currentVersion: '0.2.0', status: 'unsupported', message: 'This build cannot install updates automatically. Use Open Latest Release to download the current version.', availableVersion: null, progress: null }));
let releasePageOpens = 0;
ipcMain.handle('update:open-releases', () => { releasePageOpens += 1; return { opened: true }; });
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
  label: 'Settings UI check',
  consoleLines,
  getExtraLines: () => [`releasePageOpens=${releasePageOpens}`, `modalReports=${JSON.stringify(modalReports)}`],
});

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 700, height: 600, minWidth: 500, minHeight: 480, show: false,
    backgroundColor: '#151827',
    webPreferences: { preload: path.join(root, 'preload.js'), additionalArguments: [`--volyx-accent=${accentTheme}`], contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  trackRendererConsole(win, { lines: consoleLines });
  // Opening Settings before the renderer's boot IIFE has loaded `settings`
  // throws in openSettings() and leaves the scrim shut, so the old 450ms sleep
  // turned a slow boot into a permanent failure. Boot completion is the real
  // precondition; wait for it, with a generous first-paint budget.
  const booted = waitForRendererReady(ipcMain);
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  // Read before rendererReady: the boot script, not the later settingsGet
  // reconciliation, has to be the thing that put the theme on <html>.
  const firstFrame = await win.webContents.executeJavaScript(`({
    theme: document.documentElement.dataset.accentTheme,
    source: window.__volyxThemeBoot && window.__volyxThemeBoot.source,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  })`);
  const expectedAccent = { indigo: '#6677FF', sage: '#B3CEB7', ember: '#FFA477' }[accentTheme];
  assert.equal(firstFrame.theme, accentTheme, 'the boot script set the seeded theme');
  assert.equal(firstFrame.source, 'argv', 'a cold start reads the store argument');
  assert.equal(firstFrame.accent, expectedAccent, 'the first frame uses the seeded accent');
  await booted;
  win.show();
  await win.webContents.executeJavaScript("document.querySelector('#more-btn').click()");
  await waitFor(win, "!document.querySelector('#settings-scrim').classList.contains('hidden')", 'Settings to open');

  const sections = ['providers', 'listening', 'context', 'appearance', 'shortcuts', 'updates'];
  const expectedSectionCount = sections.length + 1;
  const heights = new Set();
  for (const section of sections) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-settings-section="${section}"]').click()`);
    await waitFor(win, `document.activeElement && document.activeElement.id === 'settings-${section}-title'`, `${section} heading focus`);
    // Let Chromium paint the already-verified section before the screenshot.
    // Geometry reads below force layout themselves, so this is not a sleep
    // standing in for a load that might not have happened.
    await waitForPaint(win);
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

  await win.webContents.executeJavaScript("document.querySelector('[data-settings-section=\"providers\"]').click(); document.querySelector('#endpoint-azure').focus()");
  const fieldFocus = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#endpoint-azure');
    const style = getComputedStyle(input);
    return { focused: document.activeElement === input, outline: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
  })()`);
  assert.equal(fieldFocus.focused, true, 'the settings field can receive focus');
  assert.equal(fieldFocus.outline, 'solid', 'a focused settings field draws an outline');
  assert.equal(fieldFocus.width, '2px', 'the focus outline is 2px');
  await win.webContents.executeJavaScript("document.querySelector('[data-settings-section=\"appearance\"]').click()");
  await waitFor(win, "document.activeElement && document.activeElement.id === 'settings-appearance-title'", 'appearance heading focus');
  const radioState = await win.webContents.executeJavaScript(`(() => {
    const radios = [...document.querySelectorAll('input[name="accent-theme"]')];
    return { count: radios.length, checked: radios.filter((radio) => radio.checked).map((radio) => radio.value), legend: document.querySelector('.s-theme-group legend').textContent, name: radios[0].name };
  })()`);
  assert.equal(radioState.count, 3, 'all three accent themes are exposed as radios');
  assert.deepEqual(radioState.checked, [accentTheme], 'the seeded theme is the initial checked theme');
  assert.equal(radioState.name, 'accent-theme', 'the radios share one native group');
  assert.equal(radioState.legend, 'Accent theme');
  // The native radio group is one tab stop; Tab must not escape to the hidden app.
  await win.webContents.executeJavaScript("document.querySelector('input[name=\"accent-theme\"]:checked').focus()");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await waitFor(win, "document.activeElement && document.activeElement.closest('#settings') !== null", 'focus to stay inside Settings after Tab');
  const trapped = await win.webContents.executeJavaScript("document.activeElement.closest('#settings') !== null");
  assert.equal(trapped, true, 'Tab from the selected theme stays inside Settings');
  await win.webContents.executeJavaScript("document.querySelector('input[name=\"accent-theme\"][value=\"sage\"]').click()");
  await waitFor(win, "document.documentElement.dataset.accentTheme === 'sage'", 'sage theme applies');
  const themeState = await win.webContents.executeJavaScript(`({
    attr: document.documentElement.dataset.accentTheme,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    hint: localStorage.getItem('volyx.accentTheme')
  })`);
  assert.equal(themeState.attr, 'sage');
  assert.equal(themeState.accent, '#B3CEB7');
  assert.equal(themeState.hint, 'sage');
  assert.equal(settings.appearance.theme, 'sage', 'the theme is persisted through settings');
  const inactiveAccent = await win.webContents.executeJavaScript(`(() => {
    window.dispatchEvent(new Event('blur'));
    const value = getComputedStyle(document.body).getPropertyValue('--accent').trim();
    window.dispatchEvent(new Event('focus'));
    return value;
  })()`);
  assert.equal(inactiveAccent, '#8FA891', 'the inactive palette follows the selected theme');

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

  // Focus must not read as the live-capture state (VR-36). Read the rule from the
  // live CSSOM so this is the stylesheet the window is actually using.
  const focusOutline = await win.webContents.executeJavaScript(`(() => {
    const rules = [];
    for (const sheet of document.styleSheets) {
      try { rules.push(...sheet.cssRules); } catch { /* cross-origin sheet */ }
    }
    // Skip the rule that *removes* the ring for pointer focus: its selector also
    // contains ":focus-visible" inside :not(, and its outline is "none".
    const focusRule = rules.find((item) => item.selectorText
      && item.selectorText.includes(':focus-visible')
      && !item.selectorText.includes(':not(')
      && item.style && item.style.outline);
    const root = getComputedStyle(document.documentElement);
    return {
      outline: focusRule ? focusRule.style.outline : '',
      accentSoft: root.getPropertyValue('--accent-soft').trim(),
      cyan: root.getPropertyValue('--cyan').trim(),
    };
  })()`);
  assert.match(focusOutline.outline, /--accent-soft/, 'the focus ring must use the accent token');
  assert.notEqual(focusOutline.accentSoft, focusOutline.cyan, 'focus must not use the live-state cyan');

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
  assert.equal(providerSemantics.total, 12, 'all providers are exposed as tabs');
  assert.equal(providerSemantics.selected, 1, 'exactly one provider tab is selected');
  assert.equal(providerSemantics.roving, 1, 'one tab is in the tab order');
  assert.equal(providerSemantics.selectedControlsPanel, true, 'the selected tab controls the visible panel');
  assert.equal(providerSemantics.panelLabelledBy, providerSemantics.selectedId, 'the panel is named by the selected tab');

  // A build without in-place updates must still have a working update button.
  await win.webContents.executeJavaScript("document.querySelector('[data-settings-section=\"updates\"]').click()");
  await waitFor(win, "document.querySelector('#update-check').dataset.mode === 'releases'", 'release fallback mode');
  const updateButton = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('#update-check'); return { text: b.textContent, disabled: b.disabled, mode: b.dataset.mode }; })()`);
  assert.equal(updateButton.text, 'Open Latest Release', 'unsupported builds label the button as a release link');
  assert.equal(updateButton.disabled, false, 'the release link is always clickable');
  await win.webContents.executeJavaScript("document.querySelector('#update-check').click()");
  // The click handler awaits the IPC round trip; the release-page counter moves
  // in the main process, so wait for the effect rather than for 40ms to pass.
  await waitForHost(() => releasePageOpens === 1, 'the update button to open the latest release page');
  assert.equal(releasePageOpens, 1, 'the button opens the latest release page');

  await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor(win, "document.querySelector('#settings-scrim').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'more-btn'", 'Settings close and focus restoration');
  const closed = await win.webContents.executeJavaScript(`({ hidden: document.querySelector('#settings-scrim').classList.contains('hidden'), active: document.activeElement && document.activeElement.id })`);
  assert.equal(closed.hidden, true, 'Escape should close Settings');
  assert.equal(closed.active, 'more-btn', 'closing Settings should restore focus');

  await win.webContents.executeJavaScript("document.querySelector('#more-btn').click()");
  await waitFor(win, "!document.querySelector('#settings-scrim').classList.contains('hidden')", 'Settings to reopen');
  win.setSize(500, 480);
  await waitFor(win, 'innerWidth === 500', 'compact viewport', FIRST_PAINT_TIMEOUT_MS);
  await waitForPaint(win);
  const compact = await win.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#settings').getBoundingClientRect();
    const nav = document.querySelector('.s-nav');
    const navRect = nav.getBoundingClientRect();
    const tabs = [...nav.querySelectorAll('button')];
    return {
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      dialogRight: dialog.right,
      width: innerWidth,
      navOverflow: nav.scrollWidth - nav.clientWidth,
      // A tab that sits outside the nav's own box is unreachable in the strip even
      // though the document itself never overflows (VR-46).
      clippedTabs: tabs.filter((tab) => {
        const rect = tab.getBoundingClientRect();
        return rect.left < navRect.left - 0.5 || rect.right > navRect.right + 0.5;
      }).length,
      tabs: tabs.length,
    };
  })()`);
  assert.equal(compact.overflowX, false, 'compact Settings must not overflow horizontally');
  assert.ok(compact.dialogRight <= compact.width, 'compact Settings dialog must fit');
  assert.equal(compact.tabs, expectedSectionCount, 'all settings sections are present at the minimum width');
  assert.equal(compact.navOverflow, 0, `the settings nav must not scroll horizontally at 500px (overflowed by ${compact.navOverflow}px)`);
  assert.equal(compact.clippedTabs, 0, 'every settings tab must sit fully inside the nav at 500px');
  await capture(win, 'compact');

  recoveryDraft = { turnCount: 500, totalTurns: 620, truncated: 120, clippedTurns: 2, startedAt: Date.now() - 60000, updatedAt: Date.now() };
  // BrowserWindow.reload() is not awaitable. Attach the boot listener before
  // reloading, because polling executeJavaScript across the navigation can throw
  // "render frame was disposed" and turn a normal reload into a failure.
  const rebooting = waitForRendererReady(ipcMain);
  win.reload();
  await rebooting;
  const reloadFrame = await win.webContents.executeJavaScript(`({
    theme: document.documentElement.dataset.accentTheme,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  })`);
  assert.equal(reloadFrame.theme, 'sage', 'a reload keeps the last selected theme, not the launch argument');
  assert.equal(reloadFrame.accent, '#B3CEB7', 'the reloaded first frame uses the saved accent');
  await waitFor(win, "document.querySelector('#meeting-recovery-dialog').open === true", 'meeting recovery dialog to open after reload');
  const recoverySummary = await win.webContents.executeJavaScript("document.querySelector('#meeting-recovery-summary').textContent");
  assert.equal(modalReports[modalReports.length - 1], true, 'recovery dialog should report an open modal');
  assert.match(recoverySummary, /500 transcript turns from .+ can be recovered\./, 'recovery summary should describe the restored draft');
  assert.match(recoverySummary, /earliest 120 turns were not saved/, 'recovery summary should disclose dropped turns');
  assert.match(recoverySummary, /2 long turns were shortened/, 'recovery summary should disclose shortened turns');
  await win.webContents.executeJavaScript("document.querySelector('#meeting-recovery-discard').click()");
  await waitFor(win, "document.querySelector('#meeting-recovery-dialog').open === false", 'recovery dialog to close after discard');
  // The dialog close and the modal-state report happen after an awaited IPC
  // call, so the report is the condition to wait for, not a 50ms sleep.
  await waitForHost(() => modalReports[modalReports.length - 1] === false, 'the recovery dialog to clear the modal state');
  assert.equal(modalReports[modalReports.length - 1], false, 'closing the recovery dialog should clear modal state');

  console.log('Settings UI behavior passed: 7 simple pages, stable layout, focus containment/restoration, compact fit, and recovery dialog modal state.');
  await guards.finish(0);
}).catch(async (error) => {
  await guards.finish(1, error);
});
