const DEFAULT_MAX_SLIDES = 20;
const DEFAULT_MAX_DISTANCE = 7;
const DEFAULT_STABLE_REQUIRED = 2;
const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_TOTAL_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARACTERS = 1200;
const MAX_SLIDE_TEXT_CHARACTERS = 4000;

function hashFrame(width, height, rgba) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 9 || height < 8
    || !rgba || rgba.length < width * height * 4) return null;

  const samples = new Array(9 * 8);
  for (let y = 0; y < 8; y += 1) {
    const startY = Math.floor((y * height) / 8);
    const endY = Math.floor(((y + 1) * height) / 8);
    for (let x = 0; x < 9; x += 1) {
      const startX = Math.floor((x * width) / 9);
      const endX = Math.floor(((x + 1) * width) / 9);
      let luminance = 0;
      let pixelCount = 0;
      for (let sourceY = startY; sourceY < endY; sourceY += 1) {
        for (let sourceX = startX; sourceX < endX; sourceX += 1) {
          const offset = (sourceY * width + sourceX) * 4;
          luminance += 0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2];
          pixelCount += 1;
        }
      }
      samples[y * 9 + x] = luminance / pixelCount;
    }
  }

  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (samples[y * 9 + x] > samples[y * 9 + x + 1]) hash |= 1n << bit;
      bit += 1n;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

function hammingDistance(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[0-9a-f]{16}$/i.test(left) || !/^[0-9a-f]{16}$/i.test(right)) {
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
  const distanceLimit = Number.isSafeInteger(maxDistance) && maxDistance >= 0 ? Math.min(maxDistance, 32) : DEFAULT_MAX_DISTANCE;
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
    if (typeof hash !== 'string' || !/^[0-9a-f]{16}$/i.test(hash)) {
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
