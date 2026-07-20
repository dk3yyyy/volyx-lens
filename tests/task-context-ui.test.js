const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const taskContextModule = fs.readFileSync(path.join(root, 'src', 'task-context.js'), 'utf8');
const imageFingerprint = fs.readFileSync(path.join(root, 'src', 'image-fingerprint.js'), 'utf8');
const textIndex = fs.readFileSync(path.join(root, 'src', 'text-index.js'), 'utf8');

test('Task Context capture is explicit, local, memory-bounded, and makes no AI request', () => {
  assert.match(main, /captureTaskContextScreen\(\)/);
  assert.match(main, /captureScreenshot\(\{ maxWidth: 1920, format: 'jpeg', quality: 80, displayId: activeDisplayId\(\) \}\)/);
  assert.match(main, /No AI request was made/);
  assert.match(main, /CommandOrControl\+Shift\+C/);
  assert.match(main, /const generation = taskContextGeneration[\s\S]*generation !== taskContextGeneration/);
  assert.match(main, /function clearTaskContext\(\) \{\n\s*taskContextGeneration \+= 1/);
  const captureFunction = main.slice(main.indexOf('async function captureTaskContextScreen'), main.indexOf('function clearTaskContext'));
  assert.doesNotMatch(captureFunction, /runFeature|\.stream\(|onTrusted\('ask'/);
});

test('renderer receives metadata only and docks Task Context behind the action after Recap', () => {
  assert.match(preload, /taskContextCapture: \(\) => ipcRenderer\.invoke\('task-context:capture'\)/);
  assert.match(preload, /taskContextUndo: \(\) => ipcRenderer\.invoke\('task-context:undo'\)/);
  assert.match(preload, /taskContextList: \(offset = 0, limit = 50\) => ipcRenderer\.invoke\('task-context:list'/);
  assert.match(preload, /taskContextRemove: \(id\) => ipcRenderer\.invoke\('task-context:remove', id\)/);
  assert.match(preload, /taskContextPin: \(id, pinned\) => ipcRenderer\.invoke\('task-context:pin'/);
  assert.match(preload, /taskContextClear: \(\) => ipcRenderer\.invoke\('task-context:clear'\)/);
  assert.match(preload, /'task-context:state'/);
  assert.doesNotMatch(preload, /taskContext(?:Image|DataUrl|Images)/);
  assert.match(html, /id="task-context-panel" class="hidden"/);
  assert.match(html, /data-mode="recap"[\s\S]*id="task-context-toggle"/);
  assert.match(html, /id="task-context-capture"/);
  assert.match(html, /id="task-context-undo"/);
  assert.match(html, /id="task-context-clear"/);
  assert.match(html, /id="task-context-list" role="list"/);
  assert.match(html, /id="task-context-eviction"/);
  assert.match(html, /id="task-context-prev"/);
  assert.match(html, /id="task-context-next"/);
  assert.doesNotMatch(html, /<img[^>]+task-context/i);
  assert.match(renderer, /volyxLens\.taskContextCapture\(\)/);
  assert.match(renderer, /volyxLens\.taskContextUndo\(\)/);
  assert.match(renderer, /volyxLens\.taskContextList\(requestedOffset, taskContextPage\.limit\)/);
  assert.match(renderer, /volyxLens\.taskContextRemove\(id\)/);
  assert.match(renderer, /volyxLens\.taskContextPin\(id, !capture\.pinned\)/);
  assert.match(renderer, /volyxLens\.taskContextClear\(\)/);
  assert.match(renderer, /setTaskContextOpen/);
  assert.match(renderer, /querySelectorAll\('\.act\[data-mode\]'\)/);
  assert.doesNotMatch(renderer, /querySelectorAll\('\.act'\)/);
  assert.match(css, /#task-context-panel/);
});

test('Task Context metadata IPC is bounded and never returns screenshot bytes or hashes', () => {
  assert.match(main, /handleTrusted\('task-context:list',[^\n]*taskContext\.list/);
  assert.match(main, /handleTrusted\('task-context:remove'/);
  assert.match(main, /handleTrusted\('task-context:pin'/);
  assert.match(taskContextModule, /Math\.min\(limit, 100\)/);
  const metadataFunction = taskContextModule.slice(taskContextModule.indexOf('function metadata'), taskContextModule.indexOf('function totalBytes'));
  assert.doesNotMatch(metadataFunction, /dataUrl|hash/);
  assert.match(renderer, /title\.textContent = `Screen \$\{capture\.sequence\}/);
  assert.match(renderer, /meta\.textContent =/);
  assert.doesNotMatch(renderer.slice(renderer.indexOf('function renderTaskContextEntries'), renderer.indexOf('async function refreshTaskContextList')), /innerHTML|createElement\('img'\)|dataUrl|hash/);
});

test('local perceptual fingerprints reject near-duplicates without crossing the renderer boundary', () => {
  assert.match(main, /fingerprintDataUrl\(dataUrl, nativeImage\)/);
  assert.match(main, /isNearDuplicate: isNearDuplicateFingerprint/);
  assert.match(main, /visually similar screen, so the new capture was not saved\. No AI request was made/);
  assert.match(imageFingerprint, /FINGERPRINT_WIDTH = 17/);
  assert.match(imageFingerprint, /FINGERPRINT_HEIGHT = 16/);
  assert.match(taskContextModule, /capture\.fingerprint && isNearDuplicate\(fingerprint, capture\.fingerprint\)/);
  assert.match(renderer, /similar skipped/);
  assert.match(renderer, /visual \$\{fingerprintFailures === 1 \? 'check' : 'checks'\} unavailable/);
  assert.doesNotMatch(preload, /fingerprint|differenceHash|averageHash|meanLuma|lumaSpread/);
  assert.doesNotMatch(renderer, /differenceHash|averageHash|meanLuma|lumaSpread/);
});

test('scroll overlap and relevance selection remain local, bounded, and metadata-only', () => {
  assert.match(main, /detectOverlap: detectTextOverlap/);
  assert.match(main, /scoreRelevance: scoreTextRelevance/);
  assert.match(main, /orderedTranscript\.slice\(-24\)/);
  assert.match(main, /relevanceQuery[\s\S]*slice\(-8000\)/);
  assert.match(taskContextModule, /index - 8/);
  assert.match(taskContextModule, /ocrUniqueText \|\| capture\.ocrText/);
  assert.match(taskContextModule, /strategy: 'relevance'/);
  assert.match(textIndex, /DEFAULT_MAX_LINES = 300/);
  assert.match(textIndex, /MIN_OVERLAP_LINES = 4/);
  assert.match(renderer, /Overlap: lines \$\{capture\.overlapLineStart\}–\$\{capture\.overlapLineEnd\}/);
  assert.doesNotMatch(preload, /ocrUniqueText|relevanceQuery|uniqueLaterText|scoreRelevance/);
  assert.doesNotMatch(renderer, /ocrUniqueText|uniqueLaterText|relevanceQuery/);
  const metadataFunction = taskContextModule.slice(taskContextModule.indexOf('function metadata'), taskContextModule.indexOf('function totalBytes'));
  assert.doesNotMatch(metadataFunction, /ocrUniqueText|uniqueLaterText/);
});

test('saved screens are disclosed and used only by screen-capable explicit requests', () => {
  assert.match(main, /const taskContextPreview = def\.needsScreen && llm\.supportsVision/);
  assert.match(main, /imageDataUrls = \[\.\.\.savedTaskImages/);
  assert.match(main, /selectImages\(MAX_SAVED_TASK_IMAGES_PER_REQUEST, \{ query: relevanceQuery \}\)/);
  assert.match(main, /Visual task context:/);
  assert.match(main, /imageDataUrls,/);
  assert.match(renderer, /Task context:/);
});

test('large visual requests require confirmation before capture or upload', () => {
  assert.match(main, /LARGE_TASK_CONTEXT_CONFIRM_THRESHOLD = 8/);
  assert.match(main, /availableTaskContextCount >= LARGE_TASK_CONTEXT_CONFIRM_THRESHOLD && !confirmedTaskContext/);
  assert.match(main, /send\('llm:confirm-task-context'/);
  assert.match(renderer, /volyxLens\.on\('llm:confirm-task-context'/);
  assert.match(renderer, /Multiple images can increase latency and provider cost/);
  assert.match(renderer, /confirmedTaskContext: true/);
});

test('New Session and quit clear task-context images from memory', () => {
  assert.match(main, /resetTranscriptData\(\);\n\s*clearTaskContext\(\);\n\s*app\.quit\(\)/);
  assert.match(main, /resetTranscriptData\(\);\n\s*clearTaskContext\(\);\n\s*buffers\.you/);
  assert.match(renderer, /session:cleared[\s\S]*renderTaskContext\(\{ count: 0/);
});
