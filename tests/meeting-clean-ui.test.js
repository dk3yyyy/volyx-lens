const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer/renderer.js');
const html = read('renderer/index.html');

test('the meeting pane offers a clean action and a raw toggle', () => {
  assert.match(html, /id="meeting-clean"/);
  assert.match(html, /id="meeting-view-toggle"/);
  assert.match(html, /aria-pressed="false"/);
});

test('history:clean is exposed to the renderer and progress reaches the pane', () => {
  assert.match(preload, /historyClean: \(id, confirmed = false\) => ipcRenderer\.invoke\('history:clean', \{ id, confirmed \}\)/);
  assert.match(preload, /'history:clean-progress'/);
  assert.match(main, /handleTrusted\('history:clean'/);
  assert.match(main, /send\('history:clean-progress'/);
  assert.match(renderer, /volyxLens\.on\('history:clean-progress'/);
});

test('cleanup runs only from the button, never on open or on a timer', () => {
  const handler = renderer.match(/\$\('#meeting-clean'\)\.addEventListener\('click'/);
  assert.ok(handler, 'cleanup is wired to a click');
  assert.doesNotMatch(renderer, /setInterval\([^)]*historyClean/);
  assert.doesNotMatch(main, /meeting:detected[\s\S]{0,400}cleanMeetingTranscript/);
  assert.doesNotMatch(main, /finalizeMeeting[\s\S]{0,400}cleanMeetingTranscript/);
});

test('cleanup is confirmation-gated for multi-request runs and refuses past the cap', () => {
  const start = main.indexOf('async function cleanMeetingTranscript');
  assert.ok(start > 0);
  const body = main.slice(start, start + 6000);
  assert.match(body, /if \(plan\.requestCount > 1 && !confirmed\)/);
  assert.match(body, /code: 'requires_confirmation'/);
  assert.match(body, /if \(plan\.tooLong\)/);
  assert.match(body, /code: 'too_long'/);
  assert.match(body, /if \(state\.busy\) return \{ ok: false, code: 'answer_active'/);
  assert.match(body, /if \(activeHistoryJob\) return \{ ok: false, code: 'history_busy'/);
});

test('cleanup sends the shared system rules and a per-batch output budget', () => {
  const start = main.indexOf('async function cleanMeetingTranscript');
  const body = main.slice(start, start + 6000);
  assert.match(body, /CLEAN_SYSTEM_PROMPT/);
  assert.match(body, /UNTRUSTED_INPUT_RULE/);
  assert.match(body, /SOURCE_UNCERTAINTY_RULE/);
  assert.match(body, /PLAIN_TEXT_OUTPUT_RULE/);
  assert.match(body, /maxTokens: batch\.maxTokens/);
  assert.match(body, /TRUNCATED_FINISH_REASON/);
  assert.match(body, /meetingStore\.updateCleaned/);
});

test('deleting, clearing, or turning history off cancels a running job', () => {
  assert.match(main, /handleTrusted\('history:delete', \(_event, id\) => \{\s*abortActiveHistoryJob\(\);/);
  assert.match(main, /handleTrusted\('history:clear', \(\) => \{\s*abortActiveHistoryJob\(\);/);
  assert.match(main, /if \(wasHistoryEnabled && !isHistoryEnabled\) \{[\s\S]{0,240}abortActiveHistoryJob\(\);/);
  assert.match(main, /shutdownAll[\s\S]{0,1200}abortActiveHistoryJob\(\)/);
});

test('the cleaned view is rendered as text, never as HTML', () => {
  const start = renderer.indexOf('function readableMeetingTurns');
  assert.ok(start > 0);
  const body = renderer.slice(start, start + 900);
  assert.match(body, /meetingDetail\.cleaned\.texts\[index\]/);
  assert.doesNotMatch(body, /innerHTML/);
  assert.match(renderer, /text\.className = 'history-text'; text\.textContent = turn\.text;/);
});

function changedMeetingTurnsFor(detail) {
  const cleanedStart = renderer.indexOf('function hasCleanedView()');
  const cleanedEnd = renderer.indexOf('function hasOriginalWording()', cleanedStart);
  const changesStart = renderer.indexOf('function normalizeMeetingText(');
  const changesEnd = renderer.indexOf('function speakerLabelFor(', changesStart);
  assert.ok(cleanedStart >= 0 && cleanedEnd > cleanedStart, 'cleaned-view helper is present');
  assert.ok(changesStart >= 0 && changesEnd > changesStart, 'change helper is present');
  const context = { meetingDetail: detail };
  vm.runInNewContext(
    `${renderer.slice(cleanedStart, cleanedEnd)}\n${renderer.slice(changesStart, changesEnd)}`,
    context,
  );
  return context.changedMeetingTurns();
}

test('changes compare AI cleanup with original rawText when deterministic processing already ran', () => {
  const result = changedMeetingTurnsFor({
    turns: [{ channel: 'you', text: 'roadmap', rawText: 'road map', ts: 1 }],
    cleaned: { texts: ['roadmap.'] },
  });
  assert.equal(result.rows.length, 1, 'the original road map to roadmap repair stays visible');
  assert.equal(result.rows[0].raw, 'road map');
  assert.equal(result.rows[0].cleaned, 'roadmap.');
  assert.equal(result.punctuationOnly, 0);

  const punctuationOnly = changedMeetingTurnsFor({
    turns: [{ channel: 'you', text: 'roadmap', ts: 2 }],
    cleaned: { texts: ['roadmap.'] },
  });
  assert.equal(punctuationOnly.rows.length, 0, 'punctuation-only cleanup is still summarized separately');
  assert.equal(punctuationOnly.punctuationOnly, 1);
});

test('notes record which transcript they were generated from', () => {
  assert.match(main, /source: readingCleaned \? 'cleaned' : \(readingProcessed \? 'processed' : 'raw'\)/);
  assert.match(main, /sourceHash:/);
});

test('progress is reported per batch with the provider that is doing the work', () => {
  const start = main.indexOf("send('history:clean-progress'");
  const body = main.slice(start, start + 260);
  assert.match(body, /batch: index \+ 1/);
  assert.match(body, /batches: plan\.batches\.length/);
  assert.match(body, /provider: providerLabel/);
});

test('a live answer and a saved-meeting job never stream at the same time', () => {
  assert.match(main, /if \(activeHistoryJob\) \{[\s\S]{0,320}send\('llm:error', \{ message: historyJobBusyMessage\(\) \}\);/);
  assert.match(main, /if \(state\.busy \|\| responseDiagnosticPromise\) \{[\s\S]{0,500}if \(confirmedTaskContext\) send\('llm:error'/);
});

test('meeting notes surface provider failures as sanitized states', () => {
  const start = main.indexOf('async function recapMeetingRecord');
  const end = main.indexOf('async function cleanMeetingTranscript');
  const body = main.slice(start, end);
  assert.match(body, /if \(controller\.signal\.aborted\) return \{ ok: false, code: 'canceled' \};/);
  assert.match(body, /sanitizeProviderError\(error, \{ providerLabel: llm\.label \|\| settings\.provider \}\)/);
});

test('the pane disables its model actions while a live answer runs', () => {
  assert.match(renderer, /let meetingNotesGenerating = false;/);
  assert.match(renderer, /button\.disabled = value \|\| meetingCleanRunning \|\| meetingNotesGenerating;/);
  assert.match(renderer, /meetingNotesGenerating = true;/);
  assert.match(renderer, /finally \{ meetingNotesGenerating = false;/);
});
