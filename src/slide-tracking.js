const DEFAULT_MAX_SLIDES = 20;
const DEFAULT_MAX_DISTANCE = 4;
const DEFAULT_STABLE_REQUIRED = 2;
const HASH_GRID_WIDTH = 16;
const HASH_GRID_HEIGHT = 9;
const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_TOTAL_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARACTERS = 1200;
const MAX_SLIDE_TEXT_CHARACTERS = 4000;

function hashFrame(width, height, rgba) {
  // A 9x8 horizontal-only hash collapsed ordinary text slides to nearly the same
  // signature: a different title and bullet list could differ by only a few bits.
  // Use a difference hash over a 16x9 grid, with both horizontal and vertical
  // comparisons, so text rows and their edits survive downscaling. The threshold
  // stays low because a static slide is deterministic across captures.
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < HASH_GRID_WIDTH || height < HASH_GRID_HEIGHT
    || !rgba || rgba.length < width * height * 4) return null;

  const cells = new Array(HASH_GRID_WIDTH * HASH_GRID_HEIGHT);
  for (let y = 0; y < HASH_GRID_HEIGHT; y += 1) {
    const startY = Math.floor((y * height) / HASH_GRID_HEIGHT);
    const endY = Math.max(startY + 1, Math.min(height, Math.floor(((y + 1) * height) / HASH_GRID_HEIGHT)));
    for (let x = 0; x < HASH_GRID_WIDTH; x += 1) {
      const startX = Math.floor((x * width) / HASH_GRID_WIDTH);
      const endX = Math.max(startX + 1, Math.min(width, Math.floor(((x + 1) * width) / HASH_GRID_WIDTH)));
      let luminance = 0;
      let pixelCount = 0;
      for (let sourceY = startY; sourceY < endY; sourceY += 1) {
        for (let sourceX = startX; sourceX < endX; sourceX += 1) {
          const offset = (sourceY * width + sourceX) * 4;
          luminance += 0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2];
          pixelCount += 1;
        }
      }
      cells[y * HASH_GRID_WIDTH + x] = pixelCount ? luminance / pixelCount : 0;
    }
  }

  const bits = [];
  for (let y = 0; y < HASH_GRID_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_GRID_WIDTH; x += 1) {
      const index = y * HASH_GRID_WIDTH + x;
      if (x + 1 < HASH_GRID_WIDTH) bits.push(cells[index] > cells[index + 1] ? 1 : 0);
      if (y + 1 < HASH_GRID_HEIGHT) bits.push(cells[index] > cells[index + HASH_GRID_WIDTH] ? 1 : 0);
    }
  }
  while (bits.length % 4 !== 0) bits.push(0);
  let hash = '';
  for (let index = 0; index < bits.length; index += 4) {
    hash += ((bits[index] << 3) | (bits[index + 1] << 2) | (bits[index + 2] << 1) | bits[index + 3]).toString(16);
  }
  return hash;
}

function hammingDistance(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
    || !/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)
    || left.length !== right.length || left.length % 2 !== 0) {
    return Infinity;
  }
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (difference) {
    count += Number(difference & 1n);
    difference >>= 1n;
  }
  return count;
}

function createSlideTracker({
  maxSlides = DEFAULT_MAX_SLIDES,
  maxDistance = DEFAULT_MAX_DISTANCE,
  stableRequired = DEFAULT_STABLE_REQUIRED,
  now = () => Date.now(),
} = {}) {
  const limit = Number.isSafeInteger(maxSlides) && maxSlides > 0 ? Math.min(maxSlides, 100) : DEFAULT_MAX_SLIDES;
  const distanceLimit = Number.isSafeInteger(maxDistance) && maxDistance >= 0 ? Math.min(maxDistance, 64) : DEFAULT_MAX_DISTANCE;
  const stableCountRequired = Number.isSafeInteger(stableRequired) && stableRequired > 0 ? Math.min(stableRequired, 10) : DEFAULT_STABLE_REQUIRED;
  let slides = [];
  let baselineHash = null;
  let candidateHash = null;
  let candidateCount = 0;
  let nextSequence = 1;

  function metadata(slide) {
    return {
      sequence: slide.sequence,
      detectedAt: slide.detectedAt,
      transcriptExcerpt: slide.transcriptExcerpt,
      preview: slide.preview,
      text: slide.text,
      ocrStatus: slide.ocrStatus,
    };
  }

  function observe(hash, { transcriptExcerpt = '' } = {}) {
    if (typeof hash !== 'string' || !/^[0-9a-f]+$/i.test(hash) || hash.length % 2 !== 0) {
      candidateHash = null;
      candidateCount = 0;
      return { emitted: null, removed: [] };
    }
    if (!baselineHash) {
      baselineHash = hash;
      return { emitted: null, removed: [] };
    }
    if (hammingDistance(baselineHash, hash) <= distanceLimit) {
      candidateHash = null;
      candidateCount = 0;
      return { emitted: null, removed: [] };
    }

    if (candidateHash && hammingDistance(candidateHash, hash) <= distanceLimit) candidateCount += 1;
    else {
      candidateHash = hash;
      candidateCount = 1;
    }
    if (candidateCount < stableCountRequired) return { emitted: null, removed: [] };

    baselineHash = hash;
    candidateHash = null;
    candidateCount = 0;
    const slide = {
      sequence: nextSequence++,
      detectedAt: now(),
      transcriptExcerpt: String(transcriptExcerpt || '').slice(0, MAX_TRANSCRIPT_CHARACTERS),
      preview: '',
      previewBytes: 0,
      text: '',
      ocrStatus: 'pending',
    };
    slides.push(slide);
    const removed = slides.length > limit
      ? slides.splice(0, slides.length - limit).map(metadata)
      : [];
    return { emitted: metadata(slide), removed };
  }

  function attachPreview(sequence, preview) {
    const slide = slides.find((item) => item.sequence === sequence);
    if (!slide || typeof preview !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(preview)) return false;
    const bytes = Buffer.byteLength(preview, 'utf8');
    const currentBytes = slides.reduce((total, item) => total + item.previewBytes, 0);
    if (bytes > MAX_PREVIEW_BYTES || currentBytes + bytes > MAX_TOTAL_PREVIEW_BYTES) return false;
    slide.preview = preview;
    slide.previewBytes = bytes;
    return true;
  }

  function attachText(sequence, text, status = 'ready') {
    const slide = slides.find((item) => item.sequence === sequence);
    if (!slide || typeof text !== 'string' || !['ready', 'empty', 'failed', 'unavailable'].includes(status)) return false;
    slide.text = text.trim().slice(0, MAX_SLIDE_TEXT_CHARACTERS);
    slide.ocrStatus = status;
    return true;
  }

  function list() {
    return { slides: slides.map(metadata), total: slides.length };
  }

  function clear() {
    const cleared = slides.length;
    slides = [];
    baselineHash = null;
    candidateHash = null;
    candidateCount = 0;
    nextSequence = 1;
    return { cleared };
  }

  return { observe, attachPreview, attachText, list, clear };
}

module.exports = {
  DEFAULT_MAX_SLIDES,
  DEFAULT_MAX_DISTANCE,
  DEFAULT_STABLE_REQUIRED,
  hashFrame,
  hammingDistance,
  createSlideTracker,
};
