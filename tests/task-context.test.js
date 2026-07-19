const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskContext } = require('../src/task-context');
const { detectTextOverlap, scoreTextRelevance } = require('../src/text-index');

function image(label, mime = 'png') {
  return `data:image/${mime};base64,${Buffer.from(label).toString('base64')}`;
}

function codePage(start, end) {
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const line = start + offset;
    return `${line} const value${line} = computeItem(source${line});`;
  }).join('\n');
}

test('task context is bounded, ordered, deduplicated, removable, and memory-only', () => {
  let clock = 100;
  const context = createTaskContext({ maxCaptures: 3, maxTotalBytes: 10000, maxCaptureBytes: 5000, now: () => ++clock });
  assert.deepEqual(context.summary(), {
    count: 0,
    maxCaptures: 3,
    maxTotalBytes: 10000,
    totalBytes: 0,
    pinnedCount: 0,
    lastCapturedAt: null,
    revision: 0,
    lastEviction: null,
    nearDuplicatesRejected: 0,
    fingerprintFailures: 0,
    maxOcrBytes: 8 * 1024 * 1024,
    ocrBytes: 0,
    ocrReadyCount: 0,
    ocrPendingCount: 0,
    ocrUnavailableCount: 0,
    ocrFailedCount: 0,
    ocrEvictedCount: 0,
    overlapLinkedCount: 0,
  });
  assert.equal(context.add(image('problem')).added, true);
  assert.equal(context.add(image('file-a')).added, true);
  assert.equal(context.add(image('file-a')).duplicate, true);
  context.add(image('file-b'));
  const replacement = context.add(image('test-output'));
  assert.equal(replacement.evicted, 1);
  assert.equal(replacement.lastEviction.count, 1);
  assert.equal(replacement.lastEviction.captures[0].sequence, 1);
  assert.equal(replacement.count, 3);
  assert.deepEqual(context.images(), [image('file-a'), image('file-b'), image('test-output')]);
  assert.equal(context.summary().lastCapturedAt, 104);

  const page = context.list({ offset: 0, limit: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.captures.length, 2);
  assert.deepEqual(Object.keys(page.captures[0]).sort(), ['bytes', 'capturedAt', 'id', 'ocrCharacters', 'ocrStatus', 'ocrTruncated', 'overlapConfidence', 'overlapLineEnd', 'overlapLineStart', 'overlapLines', 'overlapPreviousId', 'overlapPreviousSequence', 'pinned', 'sequence']);
  assert.doesNotMatch(JSON.stringify(page), /data:image|hash/);

  const removed = context.remove(page.captures[0].id);
  assert.equal(removed.removed, true);
  assert.equal(removed.removedCapture.sequence, 2);
  assert.deepEqual(context.images(), [image('file-b'), image('test-output')]);
  const undone = context.undo();
  assert.equal(undone.undone, true);
  assert.equal(undone.count, 1);
  assert.deepEqual(context.images(), [image('file-b')]);
  const cleared = context.clear();
  assert.equal(cleared.cleared, 1);
  assert.deepEqual(context.images(), []);
  assert.equal(cleared.lastEviction, null);
});

test('default storage has no fixed screen count and paginated metadata is bounded', () => {
  const context = createTaskContext({ maxTotalBytes: 100000, maxCaptureBytes: 1000 });
  for (let index = 0; index < 120; index += 1) context.add(image(`screen-${index}`));
  assert.equal(context.summary().maxCaptures, null);
  assert.equal(context.summary().count, 120);
  assert.equal(Object.hasOwn(context.summary(), 'captures'), false);
  const page = context.list({ offset: 100, limit: 1000 });
  assert.equal(page.offset, 100);
  assert.equal(page.limit, 100);
  assert.equal(page.total, 120);
  assert.equal(page.captures.length, 20);
  assert.equal(page.captures[0].sequence, 101);
  assert.deepEqual(context.selectImages(4), {
    images: [image('screen-0'), image('screen-117'), image('screen-118'), image('screen-119')],
    total: 120,
    omitted: 116,
  });
});

test('pinned captures survive ordinary eviction and are prioritized for bounded requests', () => {
  const context = createTaskContext({ maxCaptures: 3, maxTotalBytes: 10000, maxCaptureBytes: 1000 });
  context.add(image('problem'));
  context.add(image('file-a'));
  context.add(image('file-b'));
  const problem = context.list().captures[0];
  const pinned = context.setPinned(problem.id, true);
  assert.equal(pinned.updated, true);
  assert.equal(pinned.pinnedCount, 1);
  const replacement = context.add(image('test-output'));
  assert.equal(replacement.evicted, 1);
  assert.equal(replacement.evictedCaptures[0].sequence, 2);
  assert.deepEqual(context.images(), [image('problem'), image('file-b'), image('test-output')]);
  assert.deepEqual(context.selectImages(2), {
    images: [image('problem'), image('test-output')],
    total: 3,
    omitted: 1,
  });
  assert.equal(context.list().captures[0].pinned, true);
});

test('a new capture is rejected without deleting existing screens when pins fill the budget', () => {
  const context = createTaskContext({ maxCaptures: 2, maxTotalBytes: 10000, maxCaptureBytes: 1000 });
  context.add(image('problem'));
  context.add(image('reference'));
  for (const capture of context.list().captures) context.setPinned(capture.id, true);
  const before = context.images();
  const blocked = context.add(image('new-screen'));
  assert.equal(blocked.added, false);
  assert.equal(blocked.budgetBlocked, true);
  assert.equal(blocked.evicted, 0);
  assert.equal(blocked.count, 2);
  assert.deepEqual(context.images(), before);
  assert.equal(context.add(image('new-screen')).attempted.sequence, 3);
});

test('perceptual near-duplicates are rejected conservatively without exposing fingerprints', () => {
  let fingerprintCalls = 0;
  const groups = new Map([
    [image('visual-a'), 'same-layout'],
    [image('visual-b'), 'same-layout'],
    [image('different'), 'different-layout'],
  ]);
  const context = createTaskContext({
    maxTotalBytes: 10000,
    maxCaptureBytes: 1000,
    createFingerprint(dataUrl) { fingerprintCalls += 1; return { group: groups.get(dataUrl) }; },
    isNearDuplicate: (left, right) => left.group === right.group,
  });
  assert.equal(context.add(image('visual-a')).added, true);
  const nearDuplicate = context.add(image('visual-b'));
  assert.equal(nearDuplicate.added, false);
  assert.equal(nearDuplicate.duplicate, false);
  assert.equal(nearDuplicate.nearDuplicate, true);
  assert.equal(nearDuplicate.nearDuplicatesRejected, 1);
  assert.equal(context.summary().count, 1);
  assert.equal(context.add(image('visual-a')).duplicate, true);
  assert.equal(fingerprintCalls, 2, 'exact SHA-256 duplicates should skip visual fingerprint work');
  const different = context.add(image('different'));
  assert.equal(different.addedCapture.sequence, 2);
  assert.equal(context.list().captures.length, 2);
  assert.doesNotMatch(JSON.stringify(context.list()), /fingerprint|same-layout|different-layout|hash|data:image/);
});

test('local fingerprint failures never block capture and are reset with session context', () => {
  const context = createTaskContext({
    maxTotalBytes: 10000,
    maxCaptureBytes: 1000,
    createFingerprint() { throw new Error('decoder unavailable'); },
    isNearDuplicate: () => true,
  });
  const added = context.add(image('screen'));
  assert.equal(added.added, true);
  assert.equal(added.fingerprintFailures, 1);
  assert.equal(added.count, 1);
  const cleared = context.clear();
  assert.equal(cleared.fingerprintFailures, 0);
  assert.equal(cleared.nearDuplicatesRejected, 0);
});

test('local OCR text stays private while bounded status metadata remains visible', () => {
  const context = createTaskContext({ maxTotalBytes: 10000, maxCaptureBytes: 1000, maxOcrBytes: 100, maxOcrCaptureBytes: 16 });
  const added = context.add(image('ocr-screen'));
  assert.equal(added.addedCapture.ocrStatus, 'pending');
  assert.equal(added.addedCapture.ocrCharacters, 0);
  const updated = context.setOcrResult(added.addedCapture.id, { status: 'ready', text: 'private OCR text that is long', truncated: false });
  assert.equal(updated.ocrUpdated, true);
  assert.equal(updated.ocrReadyCount, 1);
  assert.equal(updated.ocrBytes <= 16, true);
  const listed = context.list().captures[0];
  assert.equal(listed.ocrStatus, 'ready');
  assert.equal(listed.ocrCharacters, 16);
  assert.equal(listed.ocrTruncated, true);
  assert.doesNotMatch(JSON.stringify(context.summary()), /private OCR|ocrText/);
  assert.doesNotMatch(JSON.stringify(context.list()), /private OCR|ocrText|data:image/);
  const cleared = context.clear();
  assert.equal(cleared.ocrBytes, 0);
  assert.equal(cleared.ocrReadyCount, 0);
});

test('OCR memory evicts oldest unpinned text and never displaces pinned text', () => {
  const context = createTaskContext({ maxTotalBytes: 10000, maxCaptureBytes: 1000, maxOcrBytes: 12, maxOcrCaptureBytes: 8 });
  const first = context.add(image('ocr-one')).addedCapture;
  const second = context.add(image('ocr-two')).addedCapture;
  const third = context.add(image('ocr-three')).addedCapture;
  context.setOcrResult(first.id, { status: 'ready', text: '12345678' });
  context.setOcrResult(second.id, { status: 'ready', text: 'abcdefgh' });
  let captures = context.list().captures;
  assert.equal(captures[0].ocrStatus, 'evicted');
  assert.equal(captures[1].ocrStatus, 'ready');
  context.setPinned(second.id, true);
  const thirdResult = context.setOcrResult(third.id, { status: 'ready', text: 'ABCDEFGH' });
  captures = context.list().captures;
  assert.equal(captures[1].ocrStatus, 'ready');
  assert.equal(captures[1].ocrCharacters, 8);
  assert.equal(captures[2].ocrStatus, 'evicted');
  assert.equal(thirdResult.ocrEvictedCount, 2);
  assert.equal(thirdResult.ocrBytes, 8);
});

test('OCR unavailable and failed states expose no error or recognized content', () => {
  const context = createTaskContext({ maxTotalBytes: 10000, maxCaptureBytes: 1000 });
  const unavailable = context.add(image('unavailable'), { ocrStatus: 'unavailable' }).addedCapture;
  const failed = context.add(image('failed')).addedCapture;
  context.setOcrResult(failed.id, { status: 'failed', text: 'must be discarded' });
  const captures = context.list().captures;
  assert.equal(captures.find((entry) => entry.id === unavailable.id).ocrStatus, 'unavailable');
  assert.equal(captures.find((entry) => entry.id === failed.id).ocrStatus, 'failed');
  assert.doesNotMatch(JSON.stringify(captures), /must be discarded/);
});

test('overlapping code pages remain saved, link lines 40–60, and rank only unique content', () => {
  const context = createTaskContext({
    maxTotalBytes: 10000,
    maxCaptureBytes: 1000,
    detectOverlap: detectTextOverlap,
    scoreRelevance: scoreTextRelevance,
  });
  const first = context.add(image('code-lines-1-60')).addedCapture;
  const second = context.add(image('code-lines-40-100')).addedCapture;
  context.setOcrResult(first.id, { status: 'ready', text: codePage(1, 60) });
  const linked = context.setOcrResult(second.id, { status: 'ready', text: codePage(40, 100) });
  assert.equal(linked.count, 2);
  assert.equal(linked.overlapLinkedCount, 1);
  const metadata = context.list().captures;
  assert.equal(metadata[1].overlapPreviousId, first.id);
  assert.equal(metadata[1].overlapPreviousSequence, 1);
  assert.equal(metadata[1].overlapLines, 21);
  assert.equal(metadata[1].overlapLineStart, 40);
  assert.equal(metadata[1].overlapLineEnd, 60);
  assert.equal(metadata[1].overlapConfidence, 100);
  assert.deepEqual(context.selectImages(39, { query: 'Why does value80 fail on line 80?' }), {
    images: [image('code-lines-40-100')],
    total: 2,
    omitted: 1,
    strategy: 'relevance',
    relevantSelected: 1,
    overlapLinked: 0,
  });
  assert.deepEqual(context.selectImages(39, { query: 'Explain value20 on line 20' }).images, [image('code-lines-1-60')]);
  assert.deepEqual(context.selectImages(39, { query: 'Explain value50 on line 50' }).images, [image('code-lines-1-60')]);
  assert.deepEqual(context.selectImages(39, { query: 'Review computeItem across the whole file' }).images, [image('code-lines-1-60'), image('code-lines-40-100')]);
  assert.doesNotMatch(JSON.stringify(context.list()), /value40|value80|computeItem|data:image/);
});

test('pins override relevance and removing an overlap source safely removes the adjacency link', () => {
  const context = createTaskContext({
    maxTotalBytes: 10000,
    maxCaptureBytes: 1000,
    detectOverlap: detectTextOverlap,
    scoreRelevance: scoreTextRelevance,
  });
  const first = context.add(image('first-code')).addedCapture;
  const second = context.add(image('second-code')).addedCapture;
  context.setOcrResult(first.id, { status: 'ready', text: codePage(1, 60) });
  context.setOcrResult(second.id, { status: 'ready', text: codePage(40, 100) });
  context.setPinned(first.id, true);
  assert.deepEqual(context.selectImages(1, { query: 'value80 line 80' }).images, [image('first-code')]);
  context.remove(first.id);
  const remaining = context.list().captures[0];
  assert.equal(remaining.overlapPreviousId, null);
  assert.equal(remaining.overlapLines, 0);
  assert.deepEqual(context.selectImages(1, { query: 'value50 line 50' }).images, [image('second-code')]);
});

test('relevance safely falls back to all in-budget screens while any OCR result is unavailable', () => {
  const context = createTaskContext({
    maxTotalBytes: 10000,
    maxCaptureBytes: 1000,
    detectOverlap: detectTextOverlap,
    scoreRelevance: scoreTextRelevance,
  });
  const first = context.add(image('indexed')).addedCapture;
  context.add(image('pending'));
  context.setOcrResult(first.id, { status: 'ready', text: codePage(1, 60) });
  assert.deepEqual(context.selectImages(39, { query: 'value20 line 20' }), {
    images: [image('indexed'), image('pending')],
    total: 2,
    omitted: 0,
    strategy: 'fallback',
    relevantSelected: 0,
  });
});

test('task context rejects unsupported and oversized image input', () => {
  const context = createTaskContext({ maxCaptureBytes: 50, maxTotalBytes: 100 });
  assert.throws(() => context.add('https://example.test/screen.png'), /supported PNG or JPEG/);
  assert.throws(() => context.add('data:image/svg+xml;base64,PHN2Zz4='), /supported PNG or JPEG/);
  assert.throws(() => context.add(`data:image/png;base64,${'A'.repeat(80)}`), /memory limit/);
});
