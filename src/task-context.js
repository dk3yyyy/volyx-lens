const crypto = require('node:crypto');

const DEFAULT_MAX_CAPTURES = null;
const DEFAULT_MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const DEFAULT_MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OCR_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OCR_CAPTURE_BYTES = 64 * 1024;
const ALLOWED_IMAGE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\r\n]+$/;
const OCR_STATUSES = new Set(['pending', 'ready', 'failed', 'unavailable', 'evicted']);

function createTaskContext({
  maxCaptures = DEFAULT_MAX_CAPTURES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES,
  maxOcrBytes = DEFAULT_MAX_OCR_BYTES,
  maxOcrCaptureBytes = DEFAULT_MAX_OCR_CAPTURE_BYTES,
  now = () => Date.now(),
  createFingerprint = null,
  isNearDuplicate = null,
  detectOverlap = null,
  scoreRelevance = null,
} = {}) {
  const captures = [];
  const captureLimit = Number.isSafeInteger(maxCaptures) && maxCaptures > 0 ? maxCaptures : null;
  const ocrTotalLimit = Number.isSafeInteger(maxOcrBytes) && maxOcrBytes > 0 ? maxOcrBytes : DEFAULT_MAX_OCR_BYTES;
  const ocrCaptureLimit = Number.isSafeInteger(maxOcrCaptureBytes) && maxOcrCaptureBytes > 0 ? Math.min(maxOcrCaptureBytes, ocrTotalLimit) : Math.min(DEFAULT_MAX_OCR_CAPTURE_BYTES, ocrTotalLimit);
  let nextId = 1;
  let nextSequence = 1;
  let revision = 0;
  let lastEviction = null;
  let nearDuplicatesRejected = 0;
  let fingerprintFailures = 0;
  let ocrEvictedCount = 0;

  function metadata(capture) {
    return {
      id: capture.id,
      sequence: capture.sequence,
      capturedAt: capture.capturedAt,
      bytes: capture.bytes,
      pinned: capture.pinned,
      ocrStatus: capture.ocrStatus,
      ocrCharacters: capture.ocrText ? capture.ocrText.length : 0,
      ocrTruncated: capture.ocrTruncated === true,
      overlapPreviousId: capture.overlapPreviousId || null,
      overlapPreviousSequence: Number.isSafeInteger(capture.overlapPreviousSequence) ? capture.overlapPreviousSequence : null,
      overlapLines: capture.overlapLines || 0,
      overlapConfidence: capture.overlapConfidence || 0,
      overlapLineStart: Number.isSafeInteger(capture.overlapLineStart) ? capture.overlapLineStart : null,
      overlapLineEnd: Number.isSafeInteger(capture.overlapLineEnd) ? capture.overlapLineEnd : null,
    };
  }

  function totalBytes() {
    return captures.reduce((sum, capture) => sum + capture.bytes, 0);
  }

  function totalOcrBytes() {
    return captures.reduce((sum, capture) => sum + (capture.ocrBytes || 0), 0);
  }

  function summary(extra = {}) {
    return {
      count: captures.length,
      maxCaptures: captureLimit,
      maxTotalBytes,
      totalBytes: totalBytes(),
      pinnedCount: captures.filter((capture) => capture.pinned).length,
      lastCapturedAt: captures.length ? captures[captures.length - 1].capturedAt : null,
      revision,
      lastEviction,
      nearDuplicatesRejected,
      fingerprintFailures,
      maxOcrBytes: ocrTotalLimit,
      ocrBytes: totalOcrBytes(),
      ocrReadyCount: captures.filter((capture) => capture.ocrStatus === 'ready').length,
      ocrPendingCount: captures.filter((capture) => capture.ocrStatus === 'pending').length,
      ocrUnavailableCount: captures.filter((capture) => capture.ocrStatus === 'unavailable').length,
      ocrFailedCount: captures.filter((capture) => capture.ocrStatus === 'failed').length,
      ocrEvictedCount,
      overlapLinkedCount: captures.filter((capture) => capture.overlapPreviousId).length,
      ...extra,
    };
  }

  function recomputeOverlaps() {
    for (const capture of captures) {
      capture.ocrUniqueText = capture.ocrText;
      capture.overlapPreviousId = null;
      capture.overlapPreviousSequence = null;
      capture.overlapLines = 0;
      capture.overlapConfidence = 0;
      capture.overlapLineStart = null;
      capture.overlapLineEnd = null;
    }
    if (typeof detectOverlap !== 'function') return;
    for (let index = 1; index < captures.length; index += 1) {
      const current = captures[index];
      if (current.ocrStatus !== 'ready' || !current.ocrText) continue;
      let best = null;
      let previousCapture = null;
      const lowerBound = Math.max(0, index - 8);
      for (let previousIndex = index - 1; previousIndex >= lowerBound; previousIndex -= 1) {
        const previous = captures[previousIndex];
        if (previous.ocrStatus !== 'ready' || !previous.ocrText) continue;
        let overlap = null;
        try { overlap = detectOverlap(previous.ocrText, current.ocrText); }
        catch { overlap = null; }
        if (!overlap || !Number.isSafeInteger(overlap.overlapLines) || overlap.overlapLines < 1) continue;
        const rank = overlap.overlapLines * 1000 + Math.max(0, Math.min(100, Number(overlap.confidence) || 0));
        if (!best || rank > best.rank) {
          best = { ...overlap, rank };
          previousCapture = previous;
        }
      }
      if (!best || !previousCapture) continue;
      current.ocrUniqueText = typeof best.uniqueLaterText === 'string' ? best.uniqueLaterText : current.ocrText;
      current.overlapPreviousId = previousCapture.id;
      current.overlapPreviousSequence = previousCapture.sequence;
      current.overlapLines = Math.min(10000, best.overlapLines);
      current.overlapConfidence = Math.max(0, Math.min(100, Math.round(Number(best.confidence) || 0)));
      current.overlapLineStart = Number.isSafeInteger(best.lineStart) ? best.lineStart : null;
      current.overlapLineEnd = Number.isSafeInteger(best.lineEnd) ? best.lineEnd : null;
    }
  }

  function add(dataUrl, { ocrStatus = 'pending' } = {}) {
    if (typeof dataUrl !== 'string' || !ALLOWED_IMAGE.test(dataUrl)) {
      throw new Error('Task context capture did not produce a supported PNG or JPEG image.');
    }
    const bytes = Buffer.byteLength(dataUrl, 'utf8');
    if (bytes > maxCaptureBytes || bytes > maxTotalBytes) throw new Error('Task context capture exceeded the per-screen memory limit.');
    const hash = crypto.createHash('sha256').update(dataUrl).digest('hex');
    if (captures.some((capture) => capture.hash === hash)) return summary({ added: false, duplicate: true, nearDuplicate: false, budgetBlocked: false, evicted: 0 });

    let fingerprint = null;
    if (typeof createFingerprint === 'function') {
      try { fingerprint = createFingerprint(dataUrl); }
      catch { fingerprintFailures += 1; }
    }
    if (fingerprint && typeof isNearDuplicate === 'function'
      && captures.some((capture) => capture.fingerprint && isNearDuplicate(fingerprint, capture.fingerprint))) {
      nearDuplicatesRejected += 1;
      return summary({ added: false, duplicate: false, nearDuplicate: true, budgetBlocked: false, evicted: 0 });
    }

    const capturedAt = now();
    const initialOcrStatus = ['pending', 'unavailable', 'failed'].includes(ocrStatus) ? ocrStatus : 'pending';
    const candidate = {
      id: `tc-${nextId}`,
      sequence: nextSequence,
      dataUrl,
      bytes,
      hash,
      fingerprint,
      capturedAt,
      pinned: false,
      ocrStatus: initialOcrStatus,
      ocrText: null,
      ocrBytes: 0,
      ocrTruncated: false,
      ocrUniqueText: null,
      overlapPreviousId: null,
      overlapPreviousSequence: null,
      overlapLines: 0,
      overlapConfidence: 0,
      overlapLineStart: null,
      overlapLineEnd: null,
    };
    const survivors = captures.slice();
    const evictedCaptures = [];
    const exceedsLimit = () => (captureLimit && survivors.length + 1 > captureLimit)
      || survivors.reduce((sum, capture) => sum + capture.bytes, bytes) > maxTotalBytes;

    while (exceedsLimit()) {
      const index = survivors.findIndex((capture) => !capture.pinned);
      if (index < 0) {
        return summary({ added: false, duplicate: false, nearDuplicate: false, budgetBlocked: true, evicted: 0, attempted: metadata(candidate) });
      }
      evictedCaptures.push(metadata(survivors[index]));
      survivors.splice(index, 1);
    }

    captures.splice(0, captures.length, ...survivors, candidate);
    recomputeOverlaps();
    nextId += 1;
    nextSequence += 1;
    revision += 1;
    if (evictedCaptures.length) {
      lastEviction = {
        count: evictedCaptures.length,
        occurredAt: capturedAt,
        captures: evictedCaptures.slice(0, 20),
        omitted: Math.max(0, evictedCaptures.length - 20),
      };
    }
    return summary({
      added: true,
      duplicate: false,
      nearDuplicate: false,
      budgetBlocked: false,
      evicted: evictedCaptures.length,
      evictedCaptures: evictedCaptures.slice(0, 20),
      evictedMetadataOmitted: Math.max(0, evictedCaptures.length - 20),
      addedCapture: metadata(candidate),
    });
  }

  function clear() {
    const cleared = captures.length;
    const changed = cleared > 0 || lastEviction !== null || nearDuplicatesRejected > 0 || fingerprintFailures > 0 || ocrEvictedCount > 0;
    captures.length = 0;
    nextSequence = 1;
    lastEviction = null;
    nearDuplicatesRejected = 0;
    fingerprintFailures = 0;
    ocrEvictedCount = 0;
    if (changed) revision += 1;
    return summary({ cleared });
  }

  function undo() {
    const removed = captures.pop();
    if (removed) {
      recomputeOverlaps();
      revision += 1;
    }
    return summary({ undone: !!removed, removedCapture: removed ? metadata(removed) : null });
  }

  function remove(id) {
    const index = captures.findIndex((capture) => capture.id === id);
    if (index < 0) return summary({ removed: false, removedCapture: null });
    const [removedCapture] = captures.splice(index, 1);
    recomputeOverlaps();
    revision += 1;
    return summary({ removed: true, removedCapture: metadata(removedCapture) });
  }

  function setPinned(id, pinned) {
    const capture = captures.find((entry) => entry.id === id);
    if (!capture) return summary({ updated: false, updatedCapture: null });
    const nextPinned = pinned === true;
    if (capture.pinned !== nextPinned) {
      capture.pinned = nextPinned;
      revision += 1;
    }
    return summary({ updated: true, updatedCapture: metadata(capture) });
  }

  function boundedOcrText(value) {
    const clean = String(value || '').replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
    const data = Buffer.from(clean, 'utf8');
    if (data.length <= ocrCaptureLimit) return { text: clean, bytes: data.length, truncated: false };
    const text = data.subarray(0, ocrCaptureLimit).toString('utf8').replace(/\uFFFD$/g, '');
    return { text, bytes: Buffer.byteLength(text, 'utf8'), truncated: true };
  }

  function setOcrResult(id, { status, text = '', truncated = false } = {}) {
    const capture = captures.find((entry) => entry.id === id);
    if (!capture || !OCR_STATUSES.has(status) || status === 'pending') return summary({ ocrUpdated: false, updatedCapture: null });

    capture.ocrText = null;
    capture.ocrBytes = 0;
    capture.ocrTruncated = false;
    let ocrEvicted = 0;
    if (status === 'ready') {
      const bounded = boundedOcrText(text);
      const pinnedOtherBytes = captures.reduce((sum, entry) => sum + (entry !== capture && entry.pinned ? entry.ocrBytes || 0 : 0), 0);
      if (pinnedOtherBytes + bounded.bytes > ocrTotalLimit) {
        capture.ocrStatus = 'evicted';
        ocrEvicted += 1;
      } else {
        while (totalOcrBytes() + bounded.bytes > ocrTotalLimit) {
          const oldest = captures.find((entry) => entry !== capture && !entry.pinned && entry.ocrBytes > 0);
          if (!oldest) break;
          oldest.ocrText = null;
          oldest.ocrBytes = 0;
          oldest.ocrTruncated = false;
          oldest.ocrStatus = 'evicted';
          ocrEvicted += 1;
        }
        if (totalOcrBytes() + bounded.bytes <= ocrTotalLimit) {
          capture.ocrStatus = 'ready';
          capture.ocrText = bounded.text;
          capture.ocrBytes = bounded.bytes;
          capture.ocrTruncated = truncated === true || bounded.truncated;
        } else {
          capture.ocrStatus = 'evicted';
          ocrEvicted += 1;
        }
      }
    } else {
      capture.ocrStatus = status;
    }
    ocrEvictedCount += ocrEvicted;
    recomputeOverlaps();
    revision += 1;
    return summary({ ocrUpdated: true, ocrEvicted, updatedCapture: metadata(capture) });
  }

  function list({ offset = 0, limit = 50 } = {}) {
    const safeOffset = Number.isSafeInteger(offset) && offset > 0 ? Math.min(offset, captures.length) : 0;
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
    return {
      captures: captures.slice(safeOffset, safeOffset + safeLimit).map(metadata),
      total: captures.length,
      offset: safeOffset,
      limit: safeLimit,
      revision,
    };
  }

  function images() {
    return captures.map((capture) => capture.dataUrl);
  }

  function has(id) {
    return captures.some((capture) => capture.id === id);
  }

  function fallbackSelection(maximum) {
    const selectedIds = new Set();
    for (const capture of captures) {
      if (capture.pinned && selectedIds.size < maximum) selectedIds.add(capture.id);
    }
    if (selectedIds.size < maximum && captures[0]) selectedIds.add(captures[0].id);
    for (let index = captures.length - 1; index >= 0 && selectedIds.size < maximum; index -= 1) selectedIds.add(captures[index].id);
    return selectedIds;
  }

  function selectImages(limit, { query = '' } = {}) {
    const maximum = Number.isSafeInteger(limit) && limit > 0 ? limit : captures.length;
    const boundedQuery = String(query || '').slice(-8000);
    const fallbackResult = (includeStrategy = false) => {
      if (captures.length <= maximum) return { images: images(), total: captures.length, omitted: 0, ...(includeStrategy ? { strategy: 'fallback', relevantSelected: 0 } : {}) };
      const selectedIds = fallbackSelection(maximum);
      const selected = captures.filter((capture) => selectedIds.has(capture.id));
      return { images: selected.map((capture) => capture.dataUrl), total: captures.length, omitted: captures.length - selected.length, ...(includeStrategy ? { strategy: 'fallback', relevantSelected: 0 } : {}) };
    };
    if (!boundedQuery.trim() || typeof scoreRelevance !== 'function') return fallbackResult(false);
    if (captures.some((capture) => capture.ocrStatus !== 'ready' || !capture.ocrText)) return fallbackResult(true);

    const scored = captures.map((capture) => {
      let score = 0;
      if (capture.ocrStatus === 'ready' && capture.ocrText) {
        try { score = Number(scoreRelevance(boundedQuery, capture.ocrUniqueText || capture.ocrText, capture.ocrText)) || 0; }
        catch { score = 0; }
      }
      return { capture, score: Math.max(0, score) };
    });
    const relevant = scored.filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score || right.capture.sequence - left.capture.sequence);
    if (!relevant.length) return fallbackResult(true);

    const selectedIds = new Set();
    for (const capture of captures) {
      if (capture.pinned && selectedIds.size < maximum) selectedIds.add(capture.id);
    }
    const threshold = Math.max(1, relevant[0].score * 0.35);
    for (const entry of relevant) {
      if (selectedIds.size >= maximum || entry.score < threshold) break;
      selectedIds.add(entry.capture.id);
    }
    const selected = captures.filter((capture) => selectedIds.has(capture.id));
    return {
      images: selected.map((capture) => capture.dataUrl),
      total: captures.length,
      omitted: captures.length - selected.length,
      strategy: 'relevance',
      relevantSelected: relevant.filter((entry) => selectedIds.has(entry.capture.id)).length,
      overlapLinked: selected.filter((capture) => capture.overlapPreviousId && selectedIds.has(capture.overlapPreviousId)).length,
    };
  }

  return { add, clear, undo, remove, setPinned, setOcrResult, list, images, has, selectImages, summary };
}

module.exports = {
  createTaskContext,
  DEFAULT_MAX_CAPTURES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_CAPTURE_BYTES,
  DEFAULT_MAX_OCR_BYTES,
  DEFAULT_MAX_OCR_CAPTURE_BYTES,
};
