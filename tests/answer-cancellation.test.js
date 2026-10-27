const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('answer generation is user-cancellable and hard-time-bounded across the IPC boundary', () => {
  assert.match(html, /id="cancel-response"[^>]*>Stop<\/button>/);
  assert.match(preload, /cancelResponse: \(\) => ipcRenderer\.send\('llm:cancel'\)/);
  assert.match(preload, /'llm:canceled'/);
  assert.match(main, /FEATURE_REQUEST_TIMEOUT_MS = 120000/);
  assert.match(main, /new AbortController\(\)/);
  // Cancellation still aborts the shared request controller.
  assert.match(main, /if \(!request\.controller\.signal\.aborted\) request\.controller\.abort\(\);/);
  // The hard time bound moved from one job-wide timer to a per-attempt deadline
  // inside the router, so a chunked job cannot spend the whole budget on one part
  // and an expired deadline is not mistaken for a cancel (VR-06, VR-07).
  assert.match(main, /perAttemptTimeoutMs: FEATURE_REQUEST_TIMEOUT_MS/);
  assert.doesNotMatch(main, /requestTimeout = setTimeout/);
  assert.match(main, /onTrusted\('llm:cancel'/);
  assert.match(renderer, /volyxLens\.cancelResponse\(\)/);
  assert.match(renderer, /volyxLens\.on\('llm:canceled'/);
});

test('session and application lifecycle cancel active provider work', () => {
  assert.match(main, /cancelActiveFeature\('new-session'/);
  // Clearing the transcript must tell the renderer the run ended: it owns the
  // busy state, and a silent invalidation wedged the composer (VR-05).
  assert.match(main, /handleTrusted\('transcript:clear'[\s\S]*?cancelActiveFeature\('transcript-clear', \{ notify: true, invalidate: true \}\)/);
  assert.match(main, /cancelActiveFeature\(relaunchRequested \? 'relaunch' : 'quit'/);
  assert.match(main, /sanitizeProviderError\(e, \{\s*\n\s*timedOut: Boolean\(e && e\.timedOut\)/);
});
