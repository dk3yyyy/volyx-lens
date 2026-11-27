'use strict';

// Post-session speaker attribution is opt-in and in-memory only. The recorder
// holds the Them/system channel PCM just long enough to analyze it after a
// normal stop, then every buffer is zeroed. Nothing here touches disk, the
// meeting store, or a network socket.
const MIN_RECORDED_MINUTES = 1 / 60;
const MAX_RECORDED_MINUTES = 10;

function createDiarizationRecorder({
  recordingId,
  sampleRate = 24000,
  maxMinutes = 5,
} = {}) {
  if (typeof recordingId !== 'string' || !recordingId.trim() || recordingId.length > 100) {
    throw new TypeError('A bounded diarization recording id is required.');
  }
  const rate = Number.isInteger(sampleRate) && sampleRate > 0 ? sampleRate : 24000;
  const minutes = Number.isFinite(maxMinutes)
    ? Math.max(MIN_RECORDED_MINUTES, Math.min(MAX_RECORDED_MINUTES, maxMinutes))
    : 5;
  const maxBytes = Math.floor(minutes * 60 * rate * 2);
  let chunks = [];
  let bytes = 0;
  let truncated = false;

  function releaseBuffered() {
    for (const chunk of chunks) chunk.fill(0);
    chunks = [];
    bytes = 0;
  }

  function append(pcm) {
    // A malformed chunk is refused without touching `truncated` or the byte
    // count: it is a caller bug, not retention pressure. Only real 16-bit PCM
    // can cross the recording bound and trigger the limit message.
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) return false;
    // Once the bound is crossed the whole recording is unusable: analyzing a
    // prefix would attribute a partial conversation, so refuse every later
    // chunk and let the caller report the limit instead. The buffered prefix
    // is zeroed immediately — keeping it would hold up to ten minutes of audio
    // in RAM until Stop for a recording that can never be analyzed.
    if (truncated || bytes + pcm.length > maxBytes) {
      truncated = true;
      releaseBuffered();
      return false;
    }
    chunks.push(Buffer.from(pcm));
    bytes += pcm.length;
    return true;
  }

  function snapshot() {
    // `bytes`, `durationMs` and `pcm` describe only what is still retained.
    // After an overflow that is nothing; `truncated` says why.
    return {
      recordingId,
      sampleRate: rate,
      pcm: Buffer.concat(chunks, bytes),
      bytes,
      durationMs: Math.round(bytes / 2 / rate * 1000),
      truncated,
    };
  }

  function clear() {
    for (const chunk of chunks) chunk.fill(0);
    chunks = [];
    bytes = 0;
    truncated = false;
  }

  return {
    append,
    snapshot,
    clear,
    get recordingId() { return recordingId; },
    get sampleRate() { return rate; },
    get maxBytes() { return maxBytes; },
    get bytes() { return bytes; },
    get durationMs() { return Math.round(bytes / 2 / rate * 1000); },
    get truncated() { return truncated; },
  };
}

module.exports = { createDiarizationRecorder };
