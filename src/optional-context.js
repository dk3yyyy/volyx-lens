'use strict';

function readOptionalContext(label, read, { onError = null } = {}) {
  try {
    const result = read();
    return Array.isArray(result) ? result : [];
  } catch (error) {
    try {
      if (typeof onError === 'function') onError(String(label || 'context').slice(0, 80), error);
    } catch {}
    return [];
  }
}

module.exports = { readOptionalContext };
