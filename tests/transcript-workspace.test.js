const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

test('electric-indigo theme replaces the generic blue identity with accessible semantic tokens', () => {
  assert.match(styles, /--accent:\s*#6677FF/i);
  assert.match(styles, /--accent-hi:\s*#7D8AFF/i);
  assert.match(styles, /--cyan:\s*#42CFE8/i);
  assert.match(styles, /--live:\s*#4FD19B/i);
  assert.match(styles, /--warning:\s*#F3B84B/i);
  assert.match(styles, /--danger:\s*#FF6678/i);
  assert.match(styles, /--surface-0:\s*#0B1020/i);
  assert.doesNotMatch(styles, /#3C83F5|rgba\(60,131,245/);
});

test('transcript workspace exposes timestamps, speakers, partial state, and bounded actions', () => {
  for (const id of ['transcript-workspace', 'transcript-list', 'transcript-count', 'transcript-copy', 'transcript-export', 'transcript-clear', 'diagnostics-toggle']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /value="txt"/);
  assert.match(html, /value="md"/);
  assert.match(html, /value="json"/);
  assert.match(renderer, /transcript-turn \$\{turn\.channel\}/);
  assert.match(renderer, /turn\.partial \|\| turn\.pendingText \? 'Listening…'/);
  assert.match(renderer, /text\.textContent = turn\.text/);
  assert.match(renderer, /volyxLens\.transcriptCopyTurn\(turn\.id\)/);
  assert.match(renderer, /window\.confirm\('Clear the current transcript/);
  assert.match(styles, /\.transcript-turn\.you/);
  assert.match(styles, /\.transcript-turn\.them/);
  assert.match(styles, /\.transcript-turn\.partial/);
});

test('transcript and diagnostics actions cross narrow IPC boundaries without renderer file access', () => {
  for (const channel of ['transcript:get', 'transcript:copy', 'transcript:copy-turn', 'transcript:clear', 'transcript:export', 'diagnostics:get', 'diagnostics:copy']) assert.match(main, new RegExp(`handleTrusted\\('${channel}'`));
  assert.match(preload, /transcriptExport: \(format\) => ipcRenderer\.invoke\('transcript:export', format\)/);
  assert.match(preload, /diagnosticsCopy: \(\) => ipcRenderer\.invoke\('diagnostics:copy'\)/);
  assert.doesNotMatch(preload, /writeFile|showSaveDialog|clipboard/);
  assert.match(main, /showSaveDialog/);
  assert.match(main, /mode: 0o600/);
});

test('consecutive STT segments update one stable speaker turn until the channel changes', () => {
  assert.match(main, /appendConversationSegment\(transcript, segment/);
  assert.match(main, /send\(updated \? 'transcript:update' : 'transcript'/);
  assert.match(main, /transcript:get', \(\) => transcript\.map\(publicTranscriptTurn\)/);
  assert.match(preload, /'transcript:update'/);
  assert.match(renderer, /volyxLens\.on\('transcript:update', updateTranscriptTurn\)/);
  assert.match(renderer, /activeTurn\.channel === partial\.channel/);
  assert.match(renderer, /activeTurn\.pendingText = partial\.text/);
});

test('cross-talk suppression prefers direct system audio and removes only the leaked raw segment', () => {
  assert.match(main, /findCrossTalkDuplicate\(recentTranscriptSegments, candidate, transcriptSegmentArrivalTimes, receivedAt\)/);
  assert.match(main, /normalizedChannel === 'you'[\s\S]*transcript:suppressed[\s\S]*return/);
  assert.match(main, /for \(const leakedSegment of duplicate\.turns \|\| \[duplicate\.turn\]\)/);
  assert.match(main, /removeRecentTranscriptSegment\(leakedSegment\.id\)/);
  assert.match(main, /removeTranscriptSegment\(leakedSegment\)/);
  assert.match(preload, /'transcript:remove'/);
  assert.match(preload, /'transcript:suppressed'/);
  assert.match(renderer, /volyxLens\.on\('transcript:remove', removeTranscriptTurn\)/);
  assert.match(renderer, /volyxLens\.on\('transcript:suppressed', clearSuppressedPartial\)/);
  assert.match(html, /id="diag-cross-talk"/);
  assert.match(renderer, /crossTalkSuppressed/);
});

test('sanitized diagnostics omit credentials, endpoints, transcript text, audio, and images', () => {
  const start = main.indexOf('function getSessionDiagnostics()');
  const end = main.indexOf('async function exportTranscript', start);
  const diagnosticFunction = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(diagnosticFunction, /apiKeys|endpoint|\btext\s*:|buffers|imageDataUrl|personalContext/);
  assert.match(html, /no API keys, endpoints, raw audio, screen images, or transcript text/i);
});
