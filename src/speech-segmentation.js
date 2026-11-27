'use strict';

function mapVadSegments(pcm, segments, {
  inputSampleRate = 24000,
  vadSampleRate = 16000,
  paddingMs = 160,
} = {}) {
  if (!Buffer.isBuffer(pcm) || !Array.isArray(segments)) return [];
  const inputRate = Number(inputSampleRate);
  const vadRate = Number(vadSampleRate);
  if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(vadRate) || vadRate <= 0) return [];

  const bytesPerSecond = inputRate * 2;
  const paddingBytes = Math.max(0, Number(paddingMs) || 0) / 1000 * bytesPerSecond;
  const mapped = [];

  for (const segment of segments) {
    if (!segment || !Number.isFinite(segment.startSample) || !Number.isFinite(segment.endSample)) continue;
    if (segment.endSample <= segment.startSample) continue;
    let startByte = Math.floor(segment.startSample * inputRate / vadRate * 2 - paddingBytes);
    let endByte = Math.ceil(segment.endSample * inputRate / vadRate * 2 + paddingBytes);
    startByte = Math.max(0, Math.min(pcm.length, startByte));
    endByte = Math.max(0, Math.min(pcm.length, endByte));
    startByte -= startByte % 2;
    endByte -= endByte % 2;
    if (endByte <= startByte) continue;
    mapped.push({ startByte, endByte });
  }

  mapped.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
  const merged = [];
  for (const range of mapped) {
    const previous = merged[merged.length - 1];
    if (previous && range.startByte <= previous.endByte) {
      previous.endByte = Math.max(previous.endByte, range.endByte);
    } else {
      merged.push({ ...range });
    }
  }

  return merged.map((range) => ({
    ...range,
    startMs: Math.round(range.startByte / bytesPerSecond * 1000),
    endMs: Math.round(range.endByte / bytesPerSecond * 1000),
  }));
}

module.exports = { mapVadSegments };
