const SPOKEN_DIGITS = Object.freeze({
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
});
const DIGIT_TOKEN = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|[0-9])';
const SPOKEN_DIGIT_SEQUENCE = new RegExp(`\\b(${DIGIT_TOKEN}(?:[ \\t]+${DIGIT_TOKEN}){2,})\\b`, 'gi');

const NUMBER_CONTEXT = /\b(?:account|call|code|digits?|identifier|id|number|otp|phone|pin|reference|ref|serial)(?:\s+(?:is|are))?\s*$/i;

function normalizeSpokenDigits(value) {
  const text = String(value || '');
  return text.replace(SPOKEN_DIGIT_SEQUENCE, (sequence, _capture, offset) => {
    const hasExplicitDigitSignal = /\b(?:zero|oh)\b/i.test(sequence) || /[0-9]/.test(sequence);
    const context = text.slice(Math.max(0, offset - 40), offset);
    if (!hasExplicitDigitSignal && !NUMBER_CONTEXT.test(context)) return sequence;
    return sequence
      .split(/[ \t]+/)
      .map((token) => SPOKEN_DIGITS[token.toLowerCase()] ?? token)
      .join('');
  });
}

function normalizeTurns(turns) {
  return (Array.isArray(turns) ? turns : []).slice(-500).map((turn) => ({
    id: Number.isFinite(turn.id) ? turn.id : undefined,
    channel: turn.channel === 'you' ? 'you' : 'them',
    text: String(turn.text || '').trim().slice(0, 12000),
    ts: Number.isFinite(turn.ts) ? turn.ts : Date.now(),
  })).filter((turn) => turn.text);
}

function timeLabel(ts) {
  return new Date(ts).toISOString().slice(11, 19);
}

function formatTranscript(turns, format = 'txt', exportedAt = Date.now()) {
  const normalized = normalizeTurns(turns);
  if (format === 'json') {
    return JSON.stringify({
      version: 1,
      exportedAt: new Date(exportedAt).toISOString(),
      turns: normalized,
    }, null, 2) + '\n';
  }
  if (format === 'md') {
    const body = normalized.map((turn) => {
      const speaker = turn.channel === 'you' ? 'You' : 'Them';
      const text = turn.text.replace(/\n/g, '\n  ');
      return `- **${timeLabel(turn.ts)} · ${speaker}:** ${text}`;
    }).join('\n\n');
    return `# Volyx Lens transcript\n\nExported ${new Date(exportedAt).toISOString()}\n\n${body}${body ? '\n' : ''}`;
  }
  return normalized.map((turn) => {
    const speaker = turn.channel === 'you' ? 'You' : 'Them';
    return `[${timeLabel(turn.ts)}] ${speaker}: ${turn.text}`;
  }).join('\n') + (normalized.length ? '\n' : '');
}

function transcriptFilename(format = 'txt', now = Date.now()) {
  const extension = ['txt', 'md', 'json'].includes(format) ? format : 'txt';
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `volyx-lens-transcript-${stamp}.${extension}`;
}

module.exports = { normalizeTurns, normalizeSpokenDigits, formatTranscript, transcriptFilename };
