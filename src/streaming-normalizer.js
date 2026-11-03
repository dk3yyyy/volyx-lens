'use strict';

const { normalizeAnswerText } = require('./answer-normalize');

// Normalising only at the end meant the answer visibly rewrote itself: raw tokens
// painted, then the finished text replaced them. Doing it as the stream arrives
// removes the substitution, but it has to be line-oriented and fence-aware: a
// chunk boundary can fall inside a fenced block, and normalising "rg --files"
// because the fence opened in an earlier chunk would corrupt real code.

const FENCE_OPEN = /^[ \t]*(`{3,})/;

function createStreamingNormalizer({ normalize = normalizeAnswerText } = {}) {
  let buffer = '';
  let emitted = '';
  let inFence = false;
  let fenceMarker = '';

  function isFenceClose(line) {
    const trimmed = line.trim();
    return trimmed.length >= fenceMarker.length && /^`+$/.test(trimmed);
  }

  // One line at a time, so a chunk boundary never decides whether text is code.
  function transformLine(line) {
    if (inFence) {
      if (isFenceClose(line)) { inFence = false; fenceMarker = ''; }
      return line;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      inFence = true;
      fenceMarker = open[1];
      return line;
    }
    return normalize(line);
  }

  function transformComplete(text) {
    // `text` ends with a newline, so the final split element is empty and the
    // join restores every separator exactly.
    const parts = text.split('\n');
    const last = parts.length - 1;
    return parts.map((line, index) => (index === last ? line : transformLine(line))).join('\n');
  }

  return {
    // Feed a token; returns the normalised text that is now safe to paint, or ''
    // while the current line is still incomplete.
    push(chunk) {
      const text = String(chunk == null ? '' : chunk);
      if (!text) return '';
      buffer += text;
      const cut = buffer.lastIndexOf('\n');
      if (cut === -1) return '';
      const complete = buffer.slice(0, cut + 1);
      buffer = buffer.slice(cut + 1);
      const out = transformComplete(complete);
      emitted += out;
      return out;
    },
    // Flush the trailing partial line (end of answer, or cancellation).
    finish() {
      if (!buffer) return '';
      const rest = transformLine(buffer);
      buffer = '';
      emitted += rest;
      return rest;
    },
    // Everything painted so far, including the flushed tail.
    text() { return emitted; },
  };
}

module.exports = { createStreamingNormalizer };
