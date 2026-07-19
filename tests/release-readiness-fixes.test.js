const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSTT } = require('../src/stt');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const screenSource = fs.readFileSync(path.join(root, 'src', 'screen.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(root, 'src', 'store.js'), 'utf8');

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('Gemini batch STT uses its independently configured model without a network call', async () => {
  let observed = null;
  const stt = createSTT({
    apiKeys: { gemini: 'configured' },
    transcription: { mode: 'batch', geminiFallbackModel: 'gemini-audio-test' },
  }, {
    env: {},
    geminiTranscribe: async (key, wav, model) => {
      observed = { key, model, wavHeader: wav.subarray(0, 4).toString('ascii') };
      return 'hello';
    },
  });
  const result = await stt.transcribe(Buffer.alloc(4000, 1));
  assert.deepEqual(result, { text: 'hello', provider: 'gemini' });
  assert.deepEqual(observed, { key: 'configured', model: 'gemini-audio-test', wavHeader: 'RIFF' });
});

test('all primary Settings fields have explicit programmatic labels', () => {
  const ids = [
    'provider-fallback', 'key-openai', 'key-anthropic', 'key-gemini', 'key-azure', 'key-deepseek',
    'endpoint-azure', 'model-fast', 'model-smart', 'provider-test-tier', 'stt-mode',
    'stt-realtime-provider', 'key-azureRealtime', 'endpoint-azure-realtime', 'stt-azure-deployment',
    'key-deepgram', 'stt-deepgram-model',
    'stt-language', 'stt-delay', 'stt-fallback-model', 'stt-gemini-fallback-model',
    'stt-offline-enabled', 'stt-offline-cloud-fallback', 'audio-input-device', 'audio-mic-enabled',
    'audio-system-enabled', 'audio-browser-processing', 'audio-sensitivity', 'audio-silence', 'audio-cost-warning',
    'audio-session-limit', 'question-detection-enabled'
  ];
  for (const id of ids) {
    const labeledByElement = new RegExp(`<label[^>]+for="${escapeRegex(id)}"`).test(html);
    const labeledDirectly = new RegExp(`<[^>]+id="${escapeRegex(id)}"[^>]+aria-label="[^"]+"`).test(html);
    assert.ok(labeledByElement || labeledDirectly, `missing label for ${id}`);
  }
  assert.match(html, /<textarea id="input"[^>]+aria-label="Ask Volyx Lens"/);
  assert.match(styles, /\.sr-only/);
});

test('provider selector implements keyboard-operable tab semantics', () => {
  assert.match(html, /id="provider-seg" role="tablist"/);
  assert.match(html, /role="tab" aria-controls="provider-config-panel"/);
  assert.match(html, /id="provider-config-panel" role="tabpanel"/);
  assert.match(renderer, /button\.setAttribute\('aria-selected'/);
  assert.match(renderer, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  const panelStart = html.indexOf('id="provider-config-panel"');
  const panelEnd = html.indexOf('</section>', panelStart);
  const panel = html.slice(panelStart, panelEnd);
  assert.match(panel, /id="key-openai"/);
  assert.match(panel, /id="model-fast"/);
  assert.match(panel, /id="provider-test-btn"/);
});

test('privileged IPC, navigation, and media permission paths are bound to the exact renderer', () => {
  assert.match(main, /APP_ENTRY_URL = pathToFileURL/);
  assert.match(main, /url !== APP_ENTRY_URL/);
  assert.match(main, /function assertTrustedIpc/);
  assert.match(main, /event\.senderFrame/);
  assert.match(main, /function handleTrusted/);
  assert.match(main, /function onTrusted/);
  assert.match(main, /isTrustedRenderer\(webContents/);
  assert.match(main, /isTrustedRenderer\(win\.webContents, request\.frame\)/);
  assert.match(main, /details\.isMainFrame === true/);
  assert.match(main, /request\.userGesture !== true/);
  assert.match(main, /function isTrustedFileOrigin/);
  assert.match(main, /new URL\(value\)\.protocol === 'file:'/);
  assert.match(main, /isTrustedFileOrigin\(request\.securityOrigin\)/);
  assert.match(main, /request\.videoRequested !== true/);
  assert.doesNotMatch(main, /\|\| sources\[0\]/);
  assert.match(renderer, /\['dragover', 'drop'\]/);
});

test('main-process shortcuts honor modal state while emergency quit remains available', () => {
  assert.match(preload, /setModalState: \(open\)/);
  assert.match(preload, /rendererReady: \(\)/);
  assert.match(main, /let uiModalOpen = true/);
  assert.match(main, /did-start-loading[\s\S]*uiModalOpen = true[\s\S]*rendererModalStateReported = false/);
  assert.match(main, /render-process-gone[\s\S]*uiModalOpen = true[\s\S]*rendererModalStateReported = false/);
  assert.match(main, /onTrusted\('ui:modal-state'/);
  assert.match(main, /const whileUnblocked/);
  assert.match(main, /handler: whileUnblocked\(\(\) => runFeature/);
  assert.match(main, /feature: 'Stop all and quit'[\s\S]*handler: stopAllAndQuit/);
  assert.match(renderer, /volyxLens\.setModalState\(true\)/);
  assert.match(renderer, /volyxLens\.setModalState\(false\)/);
});

test('transcript clear invalidates old async results and restarts active transcription', () => {
  assert.match(main, /let transcriptEpoch = 0/);
  assert.match(main, /epoch !== transcriptEpoch/);
  assert.match(main, /handleTrusted\('transcript:clear'[\s\S]*transcriptEpoch \+= 1[\s\S]*buffers\.you = \[\]; buffers\.them = \[\][\s\S]*if \(state\.capturing\) startTranscriptionPipeline\(\)/);
});

test('capture selection, disconnect cleanup, and settings durability are explicit', () => {
  assert.match(screenSource, /displayId = null/);
  assert.match(screenSource, /getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)/);
  assert.match(main, /displayId: activeDisplayId\(\)/);
  assert.match(renderer, /handleUnexpectedTrackEnd/);
  assert.match(renderer, /Listening stopped to prevent an idle billable session/);
  assert.match(storeSource, /fs\.fsyncSync\(fd\)/);
  assert.match(storeSource, /fs\.renameSync\(temporary, FILE\)/);
  assert.match(storeSource, /function updateSettingsAndApiKeys/);
  assert.match(storeSource, /throw new Error\('Settings could not be saved to disk/);
});

test('cancellation and realtime failures expose one bounded announcement and fixed error categories', () => {
  const realtime = fs.readFileSync(path.join(root, 'src', 'realtime-stt.js'), 'utf8');
  assert.doesNotMatch(html, /class="act[^>]+aria-live=/);
  const cancelStart = renderer.indexOf("volyxLens.on('llm:canceled'");
  const cancelEnd = renderer.indexOf("volyxLens.on('llm:confirm-task-context'", cancelStart);
  const cancellation = renderer.slice(cancelStart, cancelEnd);
  assert.match(cancellation, /#assistant-status/);
  assert.doesNotMatch(cancellation, /showStatus\(/);
  assert.match(realtime, /code: 'realtime_authentication_failed'/);
  assert.match(realtime, /code: 'realtime_audio_failed'/);
  assert.match(realtime, /code: 'realtime_transport_failed'/);
  assert.doesNotMatch(realtime, /code,\s*message,\s*channel/);
});

test('permission state is refreshed from macOS rather than trusted as a cached grant', () => {
  assert.match(preload, /permissionStatus: \(kind\)/);
  assert.match(main, /handleTrusted\('permissions:status'/);
  assert.match(main, /systemPreferences\.getMediaAccessStatus\(permission\)/);
  assert.match(renderer, /async function refreshPermissionStates/);
  assert.match(renderer, /void refreshPermissionStates\(\)/);
});
