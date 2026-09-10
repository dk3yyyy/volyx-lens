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
const DIGIT_SEPARATOR = '(?:[ \\t]+|[ \\t]*,[ \\t]*)';
const SPOKEN_DIGIT_SEQUENCE = new RegExp(`\\b(${DIGIT_TOKEN}(?:${DIGIT_SEPARATOR}${DIGIT_TOKEN}){2,})\\b`, 'gi');

const NUMBER_CONTEXT = /\b(?:account|call|code|digits?|identifier|id|number|otp|phone|pin|reference|ref|serial)(?:\s+(?:is|are))?\s*$/i;
const ENUMERATION_CONTEXT = /\b(?:(?:choose|select|pick)|(?:options?|choices?)\s+(?:are|include))\s*$/i;

function normalizeSpokenDigits(value) {
  const text = String(value || '');
  return text.replace(SPOKEN_DIGIT_SEQUENCE, (sequence, _capture, offset) => {
    const tokens = sequence.toLowerCase().match(/[a-z]+|[0-9]/g) || [];
    const context = text.slice(Math.max(0, offset - 40), offset);
    if (ENUMERATION_CONTEXT.test(context)) return sequence;
    const hasExplicitDigitSignal = tokens.includes('zero') || tokens.includes('oh') || tokens.some((token) => /^[0-9]$/.test(token));
    if (!hasExplicitDigitSignal && !NUMBER_CONTEXT.test(context)) return sequence;
    return sequence
      .split(/[ \t]*,[ \t]*|[ \t]+/)
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

function srtTimecode(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.floor(ms % 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

function vttTimecode(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.floor(ms % 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

function escapeSubtitle(text) {
  return String(text || '').replace(/-->/g, '--\\>').replace(/\r?\n/g, ' ');
}

function formatTranscriptSrt(turns) {
  const normalized = normalizeTurns(turns);
  const blocks = [];
  normalized.forEach((turn, index) => {
    const speaker = turn.channel === 'you' ? 'You' : 'Them';
    const start = Number.isFinite(turn.ts) ? turn.ts : 0;
    const end = start + 4000;
    blocks.push(`${index + 1}\n${srtTimecode(start)} --> ${srtTimecode(end)}\n${speaker}: ${escapeSubtitle(turn.text)}`);
  });
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

function formatTranscriptVtt(turns) {
  const normalized = normalizeTurns(turns);
  const blocks = ['WEBVTT\n'];
  normalized.forEach((turn) => {
    const speaker = turn.channel === 'you' ? 'You' : 'Them';
    const start = Number.isFinite(turn.ts) ? turn.ts : 0;
    const end = start + 4000;
    blocks.push(`${vttTimecode(start)} --> ${vttTimecode(end)}\n${speaker}: ${escapeSubtitle(turn.text)}`);
  });
  return blocks.join('\n\n') + (normalized.length ? '\n' : '');
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
  if (format === 'srt') return formatTranscriptSrt(turns);
  if (format === 'vtt') return formatTranscriptVtt(turns);
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
  const extension = ['txt', 'md', 'json', 'srt', 'vtt'].includes(format) ? format : 'txt';
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `volyx-lens-transcript-${stamp}.${extension}`;
}

module.exports = { normalizeTurns, normalizeSpokenDigits, formatTranscript, formatTranscriptSrt, formatTranscriptVtt, transcriptFilename, srtTimecode, vttTimecode, escapeSubtitle };
