const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hashFrame, createSlideTracker } = require('../src/slide-tracking');
const { MODES } = require('../src/prompts');
const { shouldAttachScreen } = require('../src/response-context');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function slideFrame(brightColumns, width = 16, height = 16) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const bright = index % width < brightColumns ? 255 : 0;
    rgba[index * 4] = bright;
    rgba[index * 4 + 1] = bright;
    rgba[index * 4 + 2] = bright;
    rgba[index * 4 + 3] = 255;
  }
  return rgba;
}

test('slide tracking rejects invalid frame dimensions and buffers', () => {
  assert.equal(hashFrame(0, 16, Buffer.alloc(16)), null);
  assert.equal(hashFrame(7, 16, Buffer.alloc(7 * 16 * 4)), null);
  assert.equal(hashFrame(16, 16, Buffer.alloc(10)), null);
});

test('first frame establishes a baseline and stable changes emit one slide', () => {
  let now = 100;
  const tracker = createSlideTracker({ now: () => now });
  const first = hashFrame(16, 16, slideFrame(4));
  const second = hashFrame(16, 16, slideFrame(12));

  assert.equal(tracker.observe(first).emitted, null);
  now += 3000;
  assert.equal(tracker.observe(second).emitted, null);
  now += 3000;
  const result = tracker.observe(second);

  assert.equal(result.emitted.sequence, 1);
  assert.equal(result.emitted.detectedAt, now);
  assert.deepEqual(tracker.list().slides, [result.emitted]);
});

test('transient changes do not emit until consecutive samples agree', () => {
  const tracker = createSlideTracker();
  const baseline = hashFrame(16, 16, slideFrame(4));
  const changedA = hashFrame(16, 16, slideFrame(12));
  const changedB = hashFrame(16, 16, slideFrame(8));

  tracker.observe(baseline);
  tracker.observe(changedA);
  assert.equal(tracker.observe(changedB).emitted, null);
  assert.equal(tracker.list().total, 0);
});

test('slide tracker bounds its history and clear resets baseline and sequence', () => {
  const tracker = createSlideTracker({ maxSlides: 2, maxDistance: 0 });
  const frames = [2, 6, 10, 14].map((columns) => hashFrame(16, 16, slideFrame(columns)));

  tracker.observe(frames[0]);
  for (const frame of frames.slice(1)) {
    tracker.observe(frame);
    tracker.observe(frame);
  }

  assert.deepEqual(tracker.list().slides.map((slide) => slide.sequence), [2, 3]);
  assert.equal(tracker.clear().cleared, 2);
  assert.equal(tracker.list().total, 0);
  assert.equal(tracker.observe(frames[0]).emitted, null);
});

test('slide previews and transcript excerpts stay bounded and clear together', () => {
  const tracker = createSlideTracker({ stableRequired: 1 });
  const baseline = hashFrame(16, 16, slideFrame(4));
  const changed = hashFrame(16, 16, slideFrame(12));

  tracker.observe(baseline);
  const { emitted } = tracker.observe(changed, { transcriptExcerpt: 'Them: ' + 'x'.repeat(2000) });
  assert.equal(emitted.transcriptExcerpt.length, 1200);
  assert.equal(tracker.attachPreview(emitted.sequence, `data:image/jpeg;base64,${Buffer.alloc(16).toString('base64')}`), true);
  assert.equal(tracker.attachPreview(emitted.sequence, 'not-an-image'), false);
  assert.match(tracker.list().slides[0].preview, /^data:image\/jpeg;base64,/);

  tracker.clear();
  assert.equal(tracker.list().slides.length, 0);
});

test('local OCR text is normalized, bounded, and part of the reviewable slide state', () => {
  const tracker = createSlideTracker({ stableRequired: 1 });
  const baseline = hashFrame(16, 16, slideFrame(4));
  const changed = hashFrame(16, 16, slideFrame(12));
  tracker.observe(baseline);
  const { emitted } = tracker.observe(changed);

  assert.equal(tracker.attachText(emitted.sequence, '  Agenda\n  Roadmap  ', 'ready'), true);
  assert.equal(tracker.list().slides[0].text, 'Agenda\n  Roadmap');
  assert.equal(tracker.list().slides[0].ocrStatus, 'ready');
  assert.equal(tracker.attachText(emitted.sequence, 'x'.repeat(9000), 'ready'), true);
  assert.equal(tracker.list().slides[0].text.length, 4000);
  assert.equal(tracker.attachText(99, 'not present'), false);
  assert.equal(tracker.clear().cleared, 1);
});

test('slide review uses supplied slide text and transcript without attaching a screenshot', () => {
  const prompt = MODES['slide-review'].build({
    transcript: [{ channel: 'them', text: 'We will launch in June.' }],
    slideContext: 'Slide 1: Launch plan',
  });

  assert.match(prompt, /Slide 1: Launch plan/);
  assert.match(prompt, /We will launch in June\./);
  assert.equal(shouldAttachScreen({ mode: 'slide-review', userText: prompt }), false);
});

test('slide tracking is opt-in, only active while listening, visible, and clearable', () => {
  const html = read('renderer/index.html');
  const renderer = read('renderer/renderer.js');
  const main = read('main.js');
  const preload = read('preload.js');
  const defaults = read('src/provider-config.js');
  const store = read('src/store.js');

  assert.match(defaults, /slideTracking: false/);
  assert.match(store, /typeof value\.slideTracking === 'boolean'\) transcription\.slideTracking/);
  assert.match(html, /id="stt-slide-tracking" type="checkbox"/);
  assert.match(html, /id="slide-tracking-indicator"/);
  assert.match(html, /id="slide-tracking-toolbar-indicator"/);
  assert.match(renderer, /slideTracking: \$\('#stt-slide-tracking'\)\.checked/);
  assert.match(renderer, /volyxLens\.on\('slide-tracking:state'/);
  assert.match(preload, /slideTrackingClear: \(\) => ipcRenderer\.invoke\('slide-tracking:clear'\)/);
  assert.match(preload, /'slide-tracking:state'/);
  assert.match(main, /startSlideTracking\(\)/);
  assert.match(main, /stopSlideTracking\(\)/);
  assert.match(main, /handleTrusted\('slide-tracking:clear'/);
  assert.match(main, /localOcr\.recognize\(preview/);
  assert.match(main, /handleTrusted\('slide-tracking:review'/);
  assert.match(renderer, /slideTrackingReview/);
  assert.match(html, /id="slide-tracking-review"/);
});

test('slide review confirmation previews and sends the same transcript snapshot', () => {
  const main = read('main.js');
  const renderer = read('renderer/renderer.js');

  assert.match(main, /transcriptSnapshot:.*map\(publicTranscriptTurn\)/);
  assert.match(main, /transcriptContext: formatPromptTranscript/);
  assert.match(main, /slideReviewTranscript: review\.transcriptSnapshot/);
  assert.match(main, /Array\.isArray\(slideReviewTranscript\) \? slideReviewTranscript/);
  assert.match(renderer, /review\.transcriptContext/);
});

test('clearing slide tracking invalidates in-flight sampling and resumes while listening', () => {
  const main = read('main.js');
  const clearFunction = main.match(/function clearSlideTrackingData\(\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(clearFunction, /clearInterval\(slideTrackingTimer\)/);
  assert.match(clearFunction, /slideTrackingGeneration \+= 1/);
  assert.match(clearFunction, /if \(restartTracking\) startSlideTracking\(\)/);
});

test('capture lifecycle starts enabled tracking and clears it when listening stops', () => {
  const main = read('main.js');
  const captureFunction = main.match(/async function applyCaptureState\(active\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(captureFunction, /state\.capturing = true;[\s\S]*?startSlideTracking\(\);/);
  assert.match(captureFunction, /state\.capturing = false;[\s\S]*?stopSlideTracking\(\);/);
});
