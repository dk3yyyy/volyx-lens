const DEFAULT_RECENT_CONTEXT_CHARACTERS = 16000;
const DEFAULT_RECAP_CONTEXT_CHARACTERS = 48000;
const TRUNCATION_MARKER = '[Earlier conversation omitted to stay within the AI context budget.]';

function normalizeTurn(turn) {
  const text = String((turn && turn.text) || '').trim();
  if (!text) return null;
  return { channel: turn.channel === 'you' ? 'you' : 'them', text };
}

function buildTranscriptContext(turns, { maxTurns = 0, maxCharacters = DEFAULT_RECENT_CONTEXT_CHARACTERS } = {}) {
  const normalized = (Array.isArray(turns) ? turns : []).map(normalizeTurn).filter(Boolean);
  const allLines = normalized.map((turn) => `${turn.channel === 'them' ? 'Them' : 'You'}: ${turn.text}`);
  const turnLimited = maxTurns > 0 ? normalized.slice(-maxTurns) : normalized;
  const lines = turnLimited.map((turn) => `${turn.channel === 'them' ? 'Them' : 'You'}: ${turn.text}`);
  const fullText = lines.join('\n');
  const totalCharacters = allLines.join('\n').length;
  const boundedMax = Math.max(256, Math.floor(Number(maxCharacters) || DEFAULT_RECENT_CONTEXT_CHARACTERS));
  const omittedByTurnLimit = turnLimited.length < normalized.length;
  if (totalCharacters <= boundedMax && !omittedByTurnLimit) {
    return { text: fullText, truncated: false, totalCharacters, includedCharacters: totalCharacters, turnsIncluded: turnLimited.length, turnsTotal: normalized.length };
  }

  const marker = TRUNCATION_MARKER;
  const available = Math.max(0, boundedMax - marker.length - 1);
  const selected = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const separator = selected.length ? 1 : 0;
    if (line.length + separator + used <= available) {
      selected.unshift(line);
      used += line.length + separator;
      continue;
    }
    if (!selected.length && available > 32) {
      const labelEnd = line.indexOf(':') + 1;
      const label = labelEnd > 0 ? line.slice(0, labelEnd) : 'Them:';
      const tailRoom = Math.max(0, available - label.length - 2);
      selected.unshift(`${label} …${line.slice(-tailRoom)}`);
    }
    break;
  }
  const text = [marker, ...selected].join('\n').slice(0, boundedMax);
  return {
    text,
    truncated: true,
    totalCharacters,
    includedCharacters: text.length,
    turnsIncluded: selected.length,
    turnsTotal: normalized.length,
  };
}

function formatTranscriptContext(turns, options) {
  return buildTranscriptContext(turns, options).text;
}

module.exports = {
  DEFAULT_RECENT_CONTEXT_CHARACTERS,
  DEFAULT_RECAP_CONTEXT_CHARACTERS,
  TRUNCATION_MARKER,
  buildTranscriptContext,
  formatTranscriptContext,
};
