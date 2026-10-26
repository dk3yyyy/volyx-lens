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
const calls = { participant: [], discard: [], deleteMany: [], deleteOne: [] };

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
  records = records.filter((record) => !remove.has(record.id));
  return { removed: ids.length };
});
ipcMain.handle('history:delete', (_event, id) => {
  calls.deleteOne.push(id);
  records = records.filter((record) => record.id !== id);
  return { removed: true };
});
ipcMain.handle('history:clean', () => ({ ok: false, code: 'no_change', message: 'not used in this harness' }));
ipcMain.handle('history:recap', () => ({ ok: false, code: 'error', message: 'not used in this harness' }));
ipcMain.handle('history:export', () => ({ canceled: true }));

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

  await run(win, "document.querySelector('#meeting-history-toggle').click()");
  await waitFor(win, "document.querySelectorAll('#meeting-history-list .history-entry').length === 2", 'two history rows');

  const countText = await run(win, "document.querySelector('#meeting-history-count').textContent");
  assert.equal(countText, '2 meetings');

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
  await wait(200);
  const mangoRows = await run(win, "document.querySelectorAll('#meeting-history-list .history-entry').length");
  assert.equal(mangoRows, 1, 'a phrase only the cleaned copy and the notes contain still finds the meeting');
  const mangoId = await run(win, "document.querySelector('#meeting-history-list .history-entry').dataset.meetingId");
  assert.equal(mangoId, 'meeting-a');

  await run(win, `(() => {
    const box = document.querySelector('#meeting-history-search');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(200);

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

  console.log('History UI behavior passed: search, keyboard, cleaned/raw/changes views, speaker name, discard, and bulk delete.');
  app.exit(0);
}).catch((error) => {
  console.error('History UI behavior failed:', error && error.message ? error.message : error);
  app.exit(1);
});
