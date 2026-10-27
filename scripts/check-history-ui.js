// History pane behaviour harness.
//
// Drives the real renderer in a BrowserWindow with mocked IPC, and asserts the
// things the pane is supposed to do: search the wording it displays, move with
// the keyboard, switch between the raw copy, the cleaned copy and the changes,
// name the other speaker, discard a cleaned copy, and delete in bulk.
//
// Run with: npm run check:history-ui  (Electron; CI runs it under xvfb)

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { STT_MODELS } = require('../src/provider-config');

const settings = {
  provider: 'openai',
  fallbackProvider: '',
  smart: false,
  onboarded: true,
  questionDetection: true,
  assistContext: 'both',
  credentialStatus: { present: { openai: true }, secure: true, backend: 'safeStorage' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: '', smart: '' },
    gemini: { fast: '', smart: '' },
    azure: { fast: '', smart: '' },
    deepseek: { fast: '', smart: '' },
    groq: { fast: '', smart: '' },
    openrouter: { fast: '', smart: '' },
    ollama: { fast: '', smart: '' },
  },
  endpoints: { azure: '', azureRealtime: '' },
  transcription: {
    mode: 'realtime',
    realtimeProvider: 'openai',
    realtimeModel: STT_MODELS.realtime,
    azureRealtimeDeployment: '',
    fallbackModel: STT_MODELS.openaiFallback,
    geminiFallbackModel: STT_MODELS.geminiFallback,
    offlineEnabled: false,
    offlineCloudFallback: false,
    language: '',
    delay: 'low',
    historyEnabled: true,
    historyRetentionDays: 0,
    meetingDetection: false,
    slideTracking: false,
  },
  audio: { inputDeviceId: '', micEnabled: true, systemEnabled: true, sensitivity: 'balanced', silenceMs: 700, costWarningMinutes: 30, maxSessionMinutes: 60 },
};

function recordA() {
  return {
    id: 'meeting-a',
    participant: null,
    reason: 'capture-stop',
    meeting: true,
    startedAt: 1700000000000,
    endedAt: 1700003600000,
    turnCount: 3,
    turns: [
      { id: 1, channel: 'them', text: 'so the pineapple road map is going ahead', ts: 1700000001000 },
      { id: 2, channel: 'you', text: 'right and we will not ship before the audit', ts: 1700000002000 },
      { id: 3, channel: 'them', text: 'agreed', ts: 1700000003000 },
    ],
    notes: { summary: 'Talked about mango plans', source: 'raw' },
    cleaned: {
      version: 1,
      at: 1700004000000,
      model: 'deepseek-flash',
      provider: 'DeepSeek',
      texts: [
        'So the pineapple roadmap is going ahead.',
        'Right, and we will not ship before the audit.',
        'Agreed.',
      ],
      stats: { cleanedTurns: 3, rawFallbacks: 0, failedBatches: 0, batches: 1 },
    },
  };
}

function recordB() {
  return {
    id: 'meeting-b',
    participant: 'Ada Lovelace',
    reason: 'new-session',
    meeting: false,
    startedAt: 1700005000000,
    endedAt: 1700005600000,
    turnCount: 1,
    turns: [{ id: 4, channel: 'them', text: 'standalone note about kiwis', ts: 1700005001000 }],
    notes: null,
    cleaned: null,
  };
}

let records = [recordA(), recordB()];
const calls = { participant: [], discard: [], deleteMany: [], deleteOne: [], backup: [], restore: [], undo: [], restoreTrash: 0, menu: [] };
let deletedRecords = [];

function listedRecords() {
  return records.map((record) => ({
    id: record.id,
    participant: record.participant || null,
    reason: record.reason || null,
    meeting: record.meeting === true,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    turnCount: record.turns.length,
    preview: record.turns[0] ? record.turns[0].text.slice(0, 120) : '',
    hasNotes: !!(record.notes && record.notes.summary),
    hasCleaned: !!(record.cleaned && Array.isArray(record.cleaned.texts) && record.cleaned.texts.length === record.turns.length),
    previewCleaned: record.cleaned && record.cleaned.texts[0] ? record.cleaned.texts[0].slice(0, 120) : '',
    notesSummary: record.notes && record.notes.summary ? record.notes.summary.slice(0, 120) : '',
    notesSource: record.notes && record.notes.source ? record.notes.source : null,
  }));
}

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_event, patch) => Object.assign(settings, patch));
ipcMain.handle('personal-context:get', () => ({ documents: { resume: { present: false, enabled: false }, jobDescription: { present: false, enabled: false } }, secure: true, locked: false }));
ipcMain.handle('transcript:get', () => []);
ipcMain.handle('task-context:get', () => ({ count: 0, totalBytes: 0, pinnedCount: 0, revision: 0 }));
ipcMain.handle('recovery:get', () => null);
ipcMain.handle('capture:state', () => ({ active: false }));
ipcMain.handle('update:get-state', () => ({ supported: false, currentVersion: '0.7.3', status: 'unsupported', message: '', availableVersion: null, progress: null }));
ipcMain.handle('shortcuts:get', () => []);
ipcMain.handle('history:list', () => listedRecords());
ipcMain.handle('history:limits', () => ({ maxRecords: 200, trashRetentionDays: 30, trashCount: deletedRecords.length }));
let nextMenuAction = null;
ipcMain.handle('context-menu:show', (_event, payload) => {
  calls.menu.push(payload && payload.kind);
  return { action: nextMenuAction };
});
ipcMain.handle('history:get', (_event, id) => {
  const found = records.find((record) => record.id === id);
  return found ? JSON.parse(JSON.stringify(found)) : null;
});
ipcMain.handle('history:participant', (_event, payload) => {
  calls.participant.push({ id: payload && payload.id, participant: payload && payload.participant });
  const found = records.find((record) => record.id === (payload && payload.id));
  if (!found) return { updated: false };
  const value = String(payload.participant || '').trim();
  found.participant = value || null;
  return { updated: true, participant: found.participant };
});
ipcMain.handle('history:discard-cleaned', (_event, id) => {
  calls.discard.push(id);
  const found = records.find((record) => record.id === id);
  if (!found) return { updated: false };
  found.cleaned = null;
  return { updated: true };
});
ipcMain.handle('history:delete-many', (_event, ids) => {
  calls.deleteMany.push(ids);
  const remove = new Set(ids);
  deletedRecords = deletedRecords.concat(records.filter((record) => remove.has(record.id)));
  records = records.filter((record) => !remove.has(record.id));
  return { removed: ids.length, ids };
});
ipcMain.handle('history:delete', (_event, id) => {
  calls.deleteOne.push(id);
  const found = records.find((record) => record.id === id);
  if (found) deletedRecords.push(found);
  records = records.filter((record) => record.id !== id);
  return { removed: Boolean(found), trashed: Boolean(found) };
});
ipcMain.handle('history:restore-trash', () => {
  calls.restoreTrash += 1;
  const back = deletedRecords;
  deletedRecords = [];
  records = records.concat(back);
  return { restored: back.length, missing: [], blocked: 0 };
});
ipcMain.handle('history:undo-delete', (_event, ids) => {
  calls.undo.push(ids);
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  const back = deletedRecords.filter((record) => wanted.has(record.id));
  deletedRecords = deletedRecords.filter((record) => !wanted.has(record.id));
  records = records.concat(back);
  return { restored: back.length, missing: [], blocked: 0 };
});
ipcMain.handle('history:clean', () => ({ ok: false, code: 'no_change', message: 'not used in this harness' }));
ipcMain.handle('history:recap', () => ({ ok: false, code: 'error', message: 'not used in this harness' }));
ipcMain.handle('history:export', () => ({ canceled: true }));
ipcMain.handle('history:backup-all', () => {
  calls.backup.push(true);
  return { canceled: false, directory: '/tmp/vlx-backup', records: 2, unreadable: 0 };
});
let nextRestoreResult = { canceled: false, imported: 1, skipped: 0, pruned: 0 };
ipcMain.handle('history:restore-all', () => {
  calls.restore.push(true);
  return nextRestoreResult;
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(win, expression, message, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${message}`);
}
const run = (win, expression) => win.webContents.executeJavaScript(expression);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 700, height: 620, minWidth: 500, minHeight: 480, show: false,
    backgroundColor: '#151827',
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });

  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  win.show();
  await wait(450);
  // Confirmations are part of the flow under test; accept them.
  await run(win, 'void (window.confirm = () => true);');

  // An unfocused window dims its accent without moving anything. The geometry
  // check is the guard against a restyle that quietly resizes the pill.
  const focusedLook = await run(win, `(() => {
    const toolbar = document.querySelector('#toolbar').getBoundingClientRect();
    return {
      inactive: document.body.classList.contains('window-inactive'),
      accent: getComputedStyle(document.body).getPropertyValue('--accent').trim(),
      width: toolbar.width,
      height: toolbar.height,
    };
  })()`);
  await run(win, "window.dispatchEvent(new Event('blur'))");
  await waitFor(win, "document.body.classList.contains('window-inactive')", 'the inactive window state');
  const blurredLook = await run(win, `(() => {
    const toolbar = document.querySelector('#toolbar').getBoundingClientRect();
    return {
      accent: getComputedStyle(document.body).getPropertyValue('--accent').trim(),
      width: toolbar.width,
      height: toolbar.height,
    };
  })()`);
  assert.notEqual(blurredLook.accent, focusedLook.accent, 'an inactive window uses a subdued accent');
  assert.equal(Math.round(blurredLook.width), Math.round(focusedLook.width), 'the inactive state does not resize the toolbar');
  assert.equal(Math.round(blurredLook.height), Math.round(focusedLook.height), 'the inactive state does not resize the toolbar');
  await run(win, "window.dispatchEvent(new Event('focus'))");
  await waitFor(win, "!document.body.classList.contains('window-inactive')", 'the focused window state');
  assert.equal(await run(win, "getComputedStyle(document.body).getPropertyValue('--accent').trim()"), focusedLook.accent, 'focus restores the live accent');
  // System accessibility settings have to reach the real window, not just exist
  // in the stylesheet. Emulate them through the debugger and read what the
  // window actually computes.
  win.webContents.debugger.attach('1.3');
  const readToolbarSurface = () => run(win, `(() => {
    const style = getComputedStyle(document.querySelector('#toolbar'));
    return {
      blur: style.backdropFilter || style.webkitBackdropFilter || '',
      background: style.backgroundColor,
      muted: getComputedStyle(document.documentElement).getPropertyValue('--tx-mut').trim(),
    };
  })()`);
  const normalSurface = await readToolbarSurface();
  assert.match(normalSurface.blur, /blur/, 'the default panel is glass');

  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  const solidSurface = await readToolbarSurface();
  assert.equal(solidSurface.blur, 'none', 'reduce transparency removes the blur');
  assert.equal(solidSurface.background, 'rgb(11, 16, 32)', 'reduce transparency paints an opaque surface');

  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-contrast', value: 'more' }],
  });
  const strongSurface = await readToolbarSurface();
  assert.notEqual(strongSurface.muted, normalSurface.muted, 'increase contrast raises the muted text token');
  assert.match(strongSurface.blur, /blur/, 'the glass returns when only contrast is raised');

  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  win.webContents.debugger.detach();
  const restoredSurface = await readToolbarSurface();
  assert.equal(restoredSurface.muted, normalSurface.muted, 'the palette returns to its default');

  await run(win, "document.querySelector('#meeting-history-toggle').click()");
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 2", 'two history rows');

  const countText = await run(win, "document.querySelector('#meeting-history-count').textContent");
  assert.equal(countText, '2 meetings');

  // The record cap is stated up front, and a prune is reported instead of the
  // oldest meeting disappearing with no message.
  await waitFor(win, "/200 saved meetings/.test(document.querySelector('#meeting-history-limit')?.textContent || '')", 'the record cap line');
  const limitText = await run(win, "document.querySelector('#meeting-history-limit').textContent");
  assert.match(limitText, /Up to 200 saved meetings are kept on this device/, 'the pane states the cap');

  win.webContents.send('history:changed', { pruned: 1 });
  await waitFor(win, "document.querySelector('#meeting-history-prune-notice')?.classList.contains('hidden') === false", 'the prune notice');
  const pruneText = await run(win, "document.querySelector('#meeting-history-prune-text').textContent");
  assert.match(pruneText, /1 older saved meeting was removed/, 'the notice says what was removed');
  assert.match(pruneText, /200 saved meetings are kept/, 'the notice repeats the cap');

  await run(win, "document.querySelector('#meeting-history-prune-dismiss').click()");
  await waitFor(win, "document.querySelector('#meeting-history-prune-notice')?.classList.contains('hidden') === true", 'the notice dismissed');
  const dismissedLabel = await run(win, "document.querySelector('#meeting-history-prune-dismiss').textContent");
  assert.equal(dismissedLabel, 'Dismiss');

  // Right-click reaches the same actions as the buttons: a history row opens,
  // and a text field asks for the platform editing menu.
  nextMenuAction = 'open';
  await run(win, `(() => {
    const row = document.querySelector('#meeting-history-list .history-entry');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  })()`);
  await waitFor(win, "document.querySelector('#meeting-history-detail')?.classList.contains('hidden') === false", 'the row context menu opened the meeting');
  assert.deepEqual(calls.menu.slice(-1), ['history-row'], 'the row asked for the row menu');
  await run(win, "document.querySelector('#meeting-history-back').click()");
  await waitFor(win, "document.querySelector('#meeting-history-detail')?.classList.contains('hidden') === true", 'back to the list');

  nextMenuAction = null;
  await run(win, `(() => {
    const box = document.querySelector('#meeting-history-search');
    box.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  })()`);
  await waitFor(win, "true", 'the field menu resolved');
  assert.deepEqual(calls.menu.slice(-1), ['editable'], 'a text field asks for the editing roles');

  // A backup says what it wrote, and a restore says what came back.
  await waitFor(win, "document.querySelector('#meeting-history-backup-all') !== null", 'the backup control');
  await run(win, "document.querySelector('#meeting-history-backup-all').click()");
  await waitFor(win, "/Backed up 2 saved meetings/.test(document.querySelector('#meeting-history-backup-status').textContent)", 'the backup status');
  assert.equal(calls.backup.length, 1, 'the pane asked the main process for a backup');
  const backupText = await run(win, "document.querySelector('#meeting-history-backup-status').textContent");
  assert.match(backupText, /\/tmp\/vlx-backup/, 'the status names the folder the records went to');

  await waitFor(win, "document.querySelector('#meeting-history-restore-all') !== null", 'the restore control');
  await run(win, "document.querySelector('#meeting-history-restore-all').click()");
  await waitFor(win, "/Restored 1 saved meeting\\./.test(document.querySelector('#meeting-history-backup-status').textContent)", 'the restore status');
  assert.equal(calls.restore.length, 1, 'the pane asked the main process to restore');

  // A restore that cannot fit is reported as a refusal, not as a success.
  nextRestoreResult = { canceled: false, imported: 0, skipped: 0, pruned: 0, blocked: 4, capacity: 0, reason: 'no_room' };
  await run(win, "document.querySelector('#meeting-history-restore-all').click()");
  await waitFor(win, "/Not enough room: 4 saved meetings would not fit/.test(document.querySelector('#meeting-history-backup-status').textContent)", 'the no-room status');
  nextRestoreResult = { canceled: false, imported: 1, skipped: 0, pruned: 0 };

  // Search reaches the cleaned wording, not just the raw preview.
  await run(win, `(() => {
    const box = document.querySelector('#meeting-history-search');
    box.value = 'pineapple';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 2", 'raw search still matches');
  await run(win, `(() => {
    const box = document.querySelector('#meeting-history-search');
    box.value = 'mango';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  // The search is debounced, so wait for the list to narrow instead of sleeping:
  // a fixed wait measures whatever the timer has done by then, which is how this
  // assertion failed once under load while passing on the next run.
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 1", 'the cleaned-copy search to narrow the list');
  const mangoRows = await run(win, "document.querySelectorAll('#meeting-history-list .history-entry').length");
  assert.equal(mangoRows, 1, 'a phrase only the cleaned copy and the notes contain still finds the meeting');
  const mangoId = await run(win, "document.querySelector('#meeting-history-list .history-entry').dataset.meetingId");
  assert.equal(mangoId, 'meeting-a');

  await run(win, `(() => {
    const box = document.querySelector('#meeting-history-search');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 2", 'the cleared search to show both meetings');

  // Keyboard: arrow keys move between meetings.
  await run(win, "document.querySelector('#meeting-history-list .history-entry-open').focus()");
  await run(win, `
    document.querySelector('#meeting-history-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  `);
  const secondFocused = await run(win, "document.activeElement.dataset.meetingId || document.activeElement.closest('.history-entry')?.dataset.meetingId");
  assert.equal(secondFocused, 'meeting-b', 'ArrowDown moves focus to the next meeting');

  // Open the first meeting and check the view modes.
  await run(win, "document.querySelector('#meeting-history-list .history-entry[data-meeting-id=\"meeting-a\"] .history-entry-open').click()");
  await waitFor(win, "!document.querySelector('#meeting-history-detail').classList.contains('hidden')", 'detail view');

  const toggleState = await run(win, `({
    label: document.querySelector('#meeting-view-toggle').textContent,
    pressed: document.querySelector('#meeting-view-toggle').getAttribute('aria-pressed'),
    meta: document.querySelector('#meeting-history-detail-meta').textContent,
    speaker: document.querySelector('#meeting-history-turns .history-speaker').textContent,
    firstText: document.querySelector('#meeting-history-turns .history-text').textContent,
  })`);
  assert.equal(toggleState.label, 'Cleaned');
  assert.equal(toggleState.pressed, 'true');
  assert.match(toggleState.meta, /3 of 3 turns cleaned/);
  assert.equal(toggleState.speaker, 'Them');
  assert.match(toggleState.firstText, /pineapple roadmap is going ahead\./, 'the cleaned copy is shown by default');
  assert.match(await run(win, "document.querySelector('.notes-source').textContent"), /as it was heard/);

  await run(win, "document.querySelector('#meeting-view-toggle').click()");
  await wait(60);
  const rawView = await run(win, `({
    label: document.querySelector('#meeting-view-toggle').textContent,
    firstText: document.querySelector('#meeting-history-turns .history-text').textContent,
  })`);
  assert.equal(rawView.label, 'Raw');
  assert.doesNotMatch(rawView.firstText, /\.$/, 'raw wording has no added punctuation');

  await run(win, "document.querySelector('#meeting-view-toggle').click()");
  await wait(60);
  const changesView = await run(win, `({
    label: document.querySelector('#meeting-view-toggle').textContent,
    rows: document.querySelectorAll('#meeting-history-turns .history-turn').length,
    before: document.querySelector('#meeting-history-turns .history-text-before')?.textContent,
    after: document.querySelector('#meeting-history-turns .history-text-after')?.textContent,
    summary: [...document.querySelectorAll('#meeting-history-turns .history-empty')].map((node) => node.textContent).join(' '),
  })`);
  assert.equal(changesView.label, 'Changes');
  assert.equal(changesView.rows, 1, 'only turns whose words changed are listed');
  assert.match(changesView.before, /road map/);
  assert.match(changesView.after, /roadmap/);
  assert.match(changesView.summary, /punctuation or capitalisation on 2 turns/);

  // Naming the other speaker updates the transcript and is persisted.
  await run(win, `
    const input = document.querySelector('#meeting-participant');
    input.value = '  Ada Lovelace  ';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await wait(120);
  assert.deepEqual(calls.participant.at(-1), { id: 'meeting-a', participant: '  Ada Lovelace  ' });
  const namedSpeaker = await run(win, "document.querySelector('#meeting-history-turns .history-speaker').textContent");
  assert.equal(namedSpeaker, 'Ada Lovelace');

  // Discarding the cleaned copy keeps the raw transcript.
  await run(win, "document.querySelector('#meeting-view-toggle').click()");
  await wait(60);
  await run(win, "document.querySelector('#meeting-discard-cleaned').click()");
  await wait(200);
  assert.deepEqual(calls.discard, ['meeting-a']);
  const afterDiscard = await run(win, `({
    toggleHidden: document.querySelector('#meeting-view-toggle').classList.contains('hidden'),
    firstText: document.querySelector('#meeting-history-turns .history-text').textContent,
  })`);
  assert.equal(afterDiscard.toggleHidden, true, 'no cleaned copy means no view toggle');
  assert.match(afterDiscard.firstText, /pineapple road map is going ahead$/, 'raw wording remains and keeps its name');

  // Back returns focus to the row it came from.
  await run(win, "document.querySelector('#meeting-history-back').click()");
  await waitFor(win, "document.querySelector('#meeting-history-detail').classList.contains('hidden')", 'back to the list');
  const focusedAfterBack = await run(win, "document.activeElement.closest('.history-entry')?.dataset.meetingId");
  assert.equal(focusedAfterBack, 'meeting-a');

  // Bulk delete through one confirmation.
  await run(win, "document.querySelector('#meeting-history-select').click()");
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry-select').length === 2", 'select checkboxes');
  await run(win, `(() => {
    const boxes = [...document.querySelectorAll('#meeting-history-list .history-entry-select')];
    for (const box of boxes) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
  })()`);
  await wait(60);
  const bulkLabel = await run(win, "document.querySelector('#meeting-history-delete-selected').textContent");
  assert.equal(bulkLabel, 'Delete 2');
  await run(win, "document.querySelector('#meeting-history-delete-selected').click()");
  await wait(250);
  assert.equal(calls.deleteMany.length, 1);
  assert.deepEqual(calls.deleteMany[0].sort(), ['meeting-a', 'meeting-b']);
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 0", 'list emptied');

  // Deleting is recoverable: the pane offers Undo and puts the meetings back.
  await waitFor(win, "document.querySelector('#meeting-history-undo-row')?.classList.contains('hidden') === false", 'the undo row after a bulk delete');
  const bulkUndoText = await run(win, "document.querySelector('#meeting-history-undo-text').textContent");
  assert.match(bulkUndoText, /Deleted 2 saved meetings\. Undo keeps them recoverable for 30 days\./);
  await run(win, "document.querySelector('#meeting-history-undo').click()");
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 2", 'both meetings came back');
  assert.equal(calls.undo.length, 1, 'undo asked the main process to restore the deleted ids');
  assert.deepEqual(calls.undo[0].slice().sort(), ['meeting-a', 'meeting-b']);
  await waitFor(win, "document.querySelector('#meeting-history-undo-row')?.classList.contains('hidden') === true", 'the undo row cleared after a full restore');

  // The single delete goes through the same affordance.
  await run(win, "document.querySelector('#meeting-history-list .history-entry .history-entry-delete').click()");
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 1", 'one row left after a single delete');
  await waitFor(win, "/Deleted 1 saved meeting/.test(document.querySelector('#meeting-history-undo-text').textContent)", 'the single undo row');
  await run(win, "document.querySelector('#meeting-history-undo').click()");
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 2", 'the single meeting came back');
  assert.equal(calls.undo.length, 2);

  // After a relaunch the undo row is gone but the copies are not: the pane
  // reports how many are still restorable and restores them in one action.
  await run(win, "document.querySelector('#meeting-history-list .history-entry .history-entry-delete').click()");
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 1", 'one row left before the relaunch case');
  await waitFor(win, "/Restore deleted \\(1\\)/.test(document.querySelector('#meeting-history-restore-trash').textContent)", 'the restore-deleted count');
  await run(win, "document.querySelector('#meeting-history-restore-trash').click()");
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 2", 'the copy came back after the relaunch case');
  assert.equal(calls.restoreTrash, 1, 'the pane asked to restore everything still in the trash');
  await waitFor(win, "document.querySelector('#meeting-history-restore-trash')?.classList.contains('hidden') === true", 'the restore-deleted control hides once the trash is empty');

  console.log('History UI behavior passed: inactive window state, context menus, accessibility preferences, search, keyboard, cleaned/raw/changes views, speaker name, discard, bulk delete, undo, restore deleted, record cap notice, and backup/restore status.');
  app.exit(0);
}).catch((error) => {
  console.error('History UI behavior failed:', error && error.message ? error.message : error);
  app.exit(1);
});
