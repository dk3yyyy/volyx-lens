'use strict';

// UI truthfulness/accessibility follow-ups from the speech UX review:
// M10, M11 and L1-L6. These are static checks over the shipped renderer copy
// and structure; the behaviour harnesses exercise the live DOM.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');

test('M10: Whisper auto-download is disclosed at the picker and scoped in the privacy note', () => {
  // The Whisper picker must say that the selection downloads on first use and
  // that this build cannot show its progress, instead of promising the GGUF
  // Download-model flow.
  assert.match(html, /id="stt-whisper-model"[^>]*aria-describedby="stt-whisper-note"/);
  assert.match(html, /id="stt-whisper-note"[^>]*>Whisper models are not bundled/);
  assert.match(html, /downloads automatically from Hugging Face the first time offline transcription uses it/);
  assert.match(html, /does not report Whisper download progress or size/);
  assert.match(html, /no warning is shown before it starts/);
  assert.match(html, /GGUF model files download only when you choose Download model/);
  assert.match(html, /Whisper models are not covered by that promise/);
  // A visible determinate state exists for the GGUF download that does emit
  // progress, and the live status is not the progress meter.
  assert.match(html, /id="speech-model-progress"[^>]*role="progressbar"[^>]*aria-valuemin="0"[^>]*aria-valuemax="100"[^>]*aria-valuenow="0"[^>]*aria-live="off"/);
  assert.match(html, /id="speech-model-progress-fill"/);
  assert.match(renderer, /speech:model-progress/);
  assert.match(renderer, /setAttribute\('aria-valuenow', String\(percent\)\)/);
});

test('M11: the history disclosure lists everything the store keeps', () => {
  const disclosure = html.match(/<summary>What meeting history stores<\/summary><div class="s-note">([\s\S]*?)<\/div><\/details>/)[1];
  for (const kept of [
    /transcript text with local timestamps/,
    /You\/Them channel/,
    /original recognizer wording/,
    /participant name/,
    /cleaned copy/,
    /generated meeting notes/,
    /saved memory/,
    /speaker-slot timings for the system channel/,
  ]) {
    assert.match(disclosure, kept);
  }
  assert.match(disclosure, /Raw audio is never stored, including the system audio used for speaker activity/);
  assert.doesNotMatch(disclosure, /only final transcript text and local timestamps/);
});

test('L1: verifying an installed model does not claim a download happened', () => {
  assert.match(renderer, /const wasInstalled = model\.installed === true;/);
  assert.match(renderer, /passed its SHA-256 check and is ready/);
  const verifyBranch = renderer.slice(renderer.indexOf('const wasInstalled = model.installed === true;'), renderer.indexOf("$('#speech-model-warm')", renderer.indexOf('const wasInstalled = model.installed === true;')));
  assert.doesNotMatch(verifyBranch, /outcomeMessage = `\$\{model\.name\} downloaded and SHA-256 verified\.`;/);
  assert.match(verifyBranch, /\? `\$\{model\.name\} passed its SHA-256 check and is ready\.`/);
});

test('L2: warm-up success keeps the CPU fallback visible', () => {
  assert.match(renderer, /warmed\.backendFallback === true/);
  assert.match(renderer, /on CPU fallback — the GPU was unavailable or not selected, so inference will be slower/);
  assert.match(renderer, /loaded and warmed for local inference\$\{backendText\}/);
});

test('L3: progress follows the active download and every Download button is disabled', () => {
  assert.match(renderer, /event\.id !== activeSpeechModelDownload/);
  assert.match(renderer, /settings\.speechModels \|\| \[\]\)\.find\(\(entry\) => entry\.id === activeSpeechModelDownload\)/);
  assert.match(renderer, /downloading \|\| anyDownloadActive/);
  assert.match(renderer, /Another download is in progress/);
  assert.match(renderer, /Download stays disabled until it finishes or is cancelled/);
});

test('L4: the detector fallback and its missing status are stated', () => {
  const note = html.match(/id="stt-speech-detector-note"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.match(note, /falls back to simpler RMS silence detection/);
  assert.match(note, /does not expose a detector status or a Retry control/);
  assert.match(note, /cannot tell you which detector is running/);
  assert.match(note, /the fallback is real but silent/);
});

test('L5: unavailable on-device options carry a reason', () => {
  assert.match(renderer, /' \(unavailable\)'/);
  assert.match(renderer, /No on-device GGUF model is available in this build: \$\{reason\}/);
  assert.match(renderer, /settings\.localSpeech\.gguf\.reason/);
});

test('L6: the actions group, timeline heading and labelled list are exposed', () => {
  assert.match(html, /class="speech-model-actions" role="group" aria-label="On-device model actions"/);
  assert.match(renderer, /const heading = document\.createElement\('h3'\);/);
  assert.match(renderer, /heading\.id = 'meeting-diarization-title';/);
  assert.match(renderer, /setAttribute\('aria-labelledby', 'meeting-diarization-title'\)/);
  // The heading keeps the existing visual weight instead of inheriting a
  // browser-default h3.
  assert.match(styles, /\.history-diarization > h3 \{[^}]*font-size: 10px/);
});
