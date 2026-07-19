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

module.exports = { normalizeTurns, formatTranscript, transcriptFilename };
