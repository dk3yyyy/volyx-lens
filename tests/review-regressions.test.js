const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('normal transcription shutdown drains both batch channels before clearing buffers', () => {
  assert.match(main, /async function stopTranscriptionPipeline/);
  assert.match(main, /await drainBatchBuffers\(\)/);
});

test('unrelated settings writes do not restart active transcription', () => {
  assert.match(main, /function transcriptionSettingsChanged/);
  assert.match(main, /if \(transcriptionSettingsChanged\(previous, updated\)\)/);
  assert.match(main, /if \(state\.capturing\)/);
  const settingsHandler = main.match(/handleTrusted\('settings:set'[\s\S]*?\n\}\);/)[0];
  assert.doesNotMatch(settingsHandler, /startTranscriptionPipeline\(\)/);
});

test('screen capture failure is included in the model prompt', () => {
  assert.match(main, /let screenNotice/);
  assert.match(main, /'No screenshot is available because screen capture permission was not granted\.'/);
  assert.match(main, /The current screenshot was unavailable\. Use the/);
  assert.match(main, /if \(screenNotice\) built \+=/);
});

test('missing batch fallback does not misreport Azure realtime as unsupported', () => {
  assert.match(main, /Batch fallback is unavailable\. If Azure Realtime failed/);
  assert.doesNotMatch(main, /No transcription key set\. Add an OpenAI Realtime\/audio key/);
});
