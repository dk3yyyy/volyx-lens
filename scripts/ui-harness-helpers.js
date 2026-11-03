// Shared waits and failure reporting for the Electron UI harnesses.
//
// The harnesses drive the real renderer on a loaded xvfb runner, so every wait
// must be tied to a condition the app actually reaches rather than to a guessed
// duration. The timeouts are deliberately generous: a first paint or a window
// resize can take seconds on a shared runner, and failing slowly is much better
// than failing at random.

const BOOT_TIMEOUT_MS = 15000;
const FIRST_PAINT_TIMEOUT_MS = 10000;
const INTERACTION_TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${message}`)), timeoutMs);
  });
  // The loser of the race must not become an unhandled rejection.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Resolves once the renderer's boot IIFE has finished and sent
// app:renderer-ready. Attach this before loadFile()/reload() so a fast boot
// cannot beat the listener.
function waitForRendererReady(ipcMain, timeoutMs = BOOT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener('app:renderer-ready', onReady);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for the renderer to finish booting (app:renderer-ready)`));
    }, timeoutMs);
    ipcMain.once('app:renderer-ready', onReady);
  });
}

// Polls a renderer-side expression. Evaluation errors are retried (a reload or
// a not-yet-rendered node makes the expression throw transiently) and reported
// in the timeout message so the failure names both the condition and the error.
async function waitFor(win, expression, message, timeoutMs = INTERACTION_TIMEOUT_MS, onAttempt = null) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (onAttempt) await onAttempt();
    try {
      const matched = await withTimeout(
        win.webContents.executeJavaScript(`Boolean(${expression})`),
        Math.max(1, deadline - Date.now()),
        `evaluating ${expression}`,
      );
      if (matched) return;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(25);
  }
  const detail = lastError ? ` Last evaluation error: ${errorText(lastError)}` : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${message} [condition: ${expression}].${detail}`);
}

// Polls a main-process predicate, for effects that only reach the harness's IPC
// stubs (clipboard calls, modal-state reports, release-page opens).
async function waitForHost(predicate, message, timeoutMs = INTERACTION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${message}`);
}

// Two animation frames: the first one carries the pending style/layout change,
// the second confirms the compositor committed it. The timer is a floor so a
// hidden or throttled window cannot hang the harness.
async function waitForPaint(win, timeoutMs = FIRST_PAINT_TIMEOUT_MS) {
  await withTimeout(
    win.webContents.executeJavaScript(`new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(true); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 500);
    })`),
    timeoutMs,
    'two animation frames',
  );
}

// Waits for the dialog's own entry animation to finish before geometry is read.
// getBoundingClientRect() includes the animated scale(), so a mid-flight sample
// reports a smaller dialog and a footer that is not the size the CSS declares.
async function waitForEntryAnimation(win, selector, timeoutMs = FIRST_PAINT_TIMEOUT_MS) {
  const expression = `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    return element.getAnimations().every((animation) => animation.animationName !== 'overlayIn'
      || animation.playState === 'finished'
      || animation.playState === 'idle');
  })()`;
  await waitFor(win, expression, `${selector} entry animation to finish`, timeoutMs);
  await waitForPaint(win);
}

// Remembers the renderer's console output so a failed run can print it. Electron
// 43 passes a single details object; using the deprecated positional arguments
// also makes Electron print its own deprecation warning into the CI log.
function trackRendererConsole(win, { limit = 300, lines = [] } = {}) {
  win.webContents.on('console-message', (details) => {
    const level = typeof details.level === 'number'
      ? (['debug', 'info', 'warning', 'error'][details.level] || 'log')
      : (details.level || 'log');
    const location = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : '';
    lines.push(`[${level}] ${String(details.message)}${location}`);
    if (lines.length > limit) lines.shift();
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    lines.push(`[render-process-gone] ${details && details.reason ? details.reason : 'unknown'} exitCode=${details && details.exitCode}`);
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    lines.push(`[did-fail-load] ${errorCode} ${errorDescription}`);
  });
  return lines;
}

const DOM_SNAPSHOT = `(() => {
  const isVisible = (element) => {
    if (!element) return false;
    if (element.hidden) return false;
    if (element.classList && element.classList.contains('hidden')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const text = (element, length = 120) => {
    if (!element) return null;
    return String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, length);
  };
  const rect = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  };
  const active = document.activeElement;
  const scrims = {
    onboarding: isVisible(document.querySelector('#onboard-scrim')),
    settings: isVisible(document.querySelector('#settings-scrim')),
    historyPanel: isVisible(document.querySelector('#meeting-history-panel')),
  };
  const visibleSettingsPages = [...document.querySelectorAll('[data-settings-page]')]
    .filter(isVisible)
    .map((page) => page.dataset.settingsPage);
  return {
    url: location.href,
    readyState: document.readyState,
    hasFocus: document.hasFocus(),
    visibilityState: document.visibilityState,
    viewport: { width: innerWidth, height: innerHeight },
    bodyClasses: document.body.className,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    activeElement: active ? {
      id: active.id || null,
      tag: active.tagName,
      className: typeof active.className === 'string' ? active.className : null,
      text: text(active, 80),
    } : null,
    scrims,
    onboarding: {
      stepCount: text(document.querySelector('#ob-step-count'), 40),
      title: text(document.querySelector('#ob-title'), 80),
      nextLabel: text(document.querySelector('#ob-next'), 40),
      dialog: rect(document.querySelector('#onboard')),
      footerHeight: document.querySelector('.ob-footer') ? Math.round(document.querySelector('.ob-footer').getBoundingClientRect().height * 100) / 100 : null,
      permissionStatus: text(document.querySelector('#ob-permission-status'), 160),
    },
    settings: {
      visiblePages: visibleSettingsPages,
      selectedSection: document.querySelector('[data-settings-section].on') ? document.querySelector('[data-settings-section].on').dataset.settingsSection : null,
      dialog: rect(document.querySelector('#settings')),
      updateButton: text(document.querySelector('#update-check'), 60),
      updateMode: document.querySelector('#update-check') ? document.querySelector('#update-check').dataset.mode || null : null,
      recoveryOpen: document.querySelector('#meeting-recovery-dialog') ? document.querySelector('#meeting-recovery-dialog').open === true : null,
    },
    history: {
      rows: document.querySelectorAll('#meeting-history-list .history-entry').length,
      count: text(document.querySelector('#meeting-history-count'), 40),
      listVisible: isVisible(document.querySelector('#meeting-history-list')),
      detailHidden: document.querySelector('#meeting-history-detail') ? document.querySelector('#meeting-history-detail').classList.contains('hidden') : null,
      viewToggle: text(document.querySelector('#meeting-view-toggle'), 40),
      undoRowHidden: document.querySelector('#meeting-history-undo-row') ? document.querySelector('#meeting-history-undo-row').classList.contains('hidden') : null,
      backupStatus: text(document.querySelector('#meeting-history-backup-status'), 120),
    },
  };
})()`;

async function collectDomSnapshot(win) {
  return await withTimeout(win.webContents.executeJavaScript(DOM_SNAPSHOT), 3000, 'collecting the DOM snapshot');
}

// Prints everything the next CI failure needs: the error, the last DOM state,
// and the renderer console. All of it is best-effort so a dead renderer still
// produces the original error instead of replacing it with a diagnostic failure.
async function reportFailure({ label, error, win, consoleLines, extraLines = [] }) {
  console.error(`\n=== ${label}: FAILED ===`);
  console.error(error && error.stack ? error.stack : String(error));
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    try {
      const snapshot = await collectDomSnapshot(win);
      console.error('[diagnostics] last known DOM state:');
      console.error(JSON.stringify(snapshot, null, 2));
    } catch (snapshotError) {
      console.error(`[diagnostics] DOM snapshot unavailable: ${errorText(snapshotError)}`);
    }
  } else {
    console.error('[diagnostics] window is gone, so no DOM snapshot is available.');
  }
  for (const line of extraLines) console.error(`[diagnostics] ${line}`);
  const lines = Array.isArray(consoleLines) ? consoleLines : [];
  console.error(`[diagnostics] renderer console (${lines.length} message${lines.length === 1 ? '' : 's'}, oldest first):`);
  if (!lines.length) console.error('  (no renderer console messages were captured)');
  for (const line of lines) console.error(`  ${line}`);
  console.error(`=== ${label}: END DIAGNOSTICS ===\n`);
}

// The harness owns the process: success and failure both end it explicitly, so
// no Electron window, renderer, or debugger session can outlive the check. The
// watchdog turns a wedged wait into a diagnosable failure instead of a CI hang.
function installHarnessGuards({ app, getWindow, label, consoleLines, getExtraLines = () => [], watchdogMs = 120000 }) {
  let finished = false;
  let watchdog = null;

  async function finish(code, error = null) {
    if (finished) return;
    finished = true;
    if (watchdog) clearTimeout(watchdog);
    if (error) {
      try {
        await reportFailure({ label, error, win: getWindow(), consoleLines, extraLines: getExtraLines() });
      } catch (reportingError) {
        // Diagnostics are best-effort; the original error must still end the run
        // with a non-zero status instead of leaving a half-dead process behind.
        console.error('Diagnostics could not be printed:', errorText(reportingError));
      }
    }
    // exit() is terminal even if a window still exists or a debugger is
    // attached; quit() waits for windows and can hang on a wedged renderer.
    app.exit(code);
  }

  watchdog = setTimeout(() => {
    void finish(1, new Error(`The harness did not finish within ${watchdogMs}ms.`));
  }, watchdogMs);

  app.on('window-all-closed', () => {
    if (!finished) void finish(1, new Error('The harness window closed before the checks completed.'));
  });
  process.on('unhandledRejection', (reason) => {
    void finish(1, reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`));
  });
  process.on('uncaughtException', (error) => {
    void finish(1, error);
  });

  return { finish };
}

module.exports = {
  BOOT_TIMEOUT_MS,
  FIRST_PAINT_TIMEOUT_MS,
  INTERACTION_TIMEOUT_MS,
  collectDomSnapshot,
  errorText,
  installHarnessGuards,
  reportFailure,
  sleep,
  trackRendererConsole,
  waitFor,
  waitForEntryAnimation,
  waitForHost,
  waitForPaint,
  waitForRendererReady,
  withTimeout,
};
