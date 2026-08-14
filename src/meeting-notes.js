'use strict';

function timeLabel(ts) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toISOString().slice(11, 19);
}

function localStamp(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function reasonLabel(reason) {
  if (reason === 'capture-stop') return 'listening stopped';
  if (reason === 'new-session') return 'new session started';
  if (reason === 'app-quit') return 'app quit';
  return reason || 'unknown';
}

function meetingFilename(format = 'md', now = Date.now()) {
  const extension = ['txt', 'md', 'json'].includes(format) ? format : 'md';
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `volyx-lens-meeting-${stamp}.${extension}`;
}

function meetingHeader(record = {}) {
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const lines = [`# Volyx Lens ${record.meeting === true ? 'meeting' : 'session'}`];
  if (Number.isFinite(record.startedAt)) lines.push(`\nStarted: ${localStamp(record.startedAt)}`);
  if (Number.isFinite(record.endedAt)) lines.push(`Ended: ${localStamp(record.endedAt)}`);
  lines.push(`Session end: ${reasonLabel(record.reason)}`);
  lines.push(`Turns: ${turns.length}`);
  if (record.meeting === true) lines.push('Meeting: detected as a two-sided conversation');
  return lines.join('\n');
}

function normalizeTurns(record = {}) {
  return (Array.isArray(record.turns) ? record.turns : [])
    .map((turn) => ({
      channel: turn && turn.channel === 'you' ? 'you' : 'them',
      text: String((turn && turn.text) || '').trim().slice(0, 12000),
      ts: Number.isFinite(turn && turn.ts) ? turn.ts : undefined,
    }))
    .filter((turn) => turn.text);
}

function formatMeetingRecord(record = {}, format = 'md', exportedAt = Date.now()) {
  const turns = normalizeTurns(record);
  if (format === 'json') {
    return JSON.stringify({
      version: 1,
      id: record.id || null,
      reason: record.reason || null,
      meeting: record.meeting === true,
      startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
      endedAt: Number.isFinite(record.endedAt) ? record.endedAt : null,
      exportedAt: new Date(exportedAt).toISOString(),
      turns,
    }, null, 2) + '\n';
  }
  const isMarkdown = format === 'md';
  const body = turns.map((turn) => {
    const speaker = turn.channel === 'you' ? 'You' : 'Them';
    if (isMarkdown) return `- **${timeLabel(turn.ts)} · ${speaker}:** ${turn.text.replace(/\n/g, '\n  ')}`;
    return `[${timeLabel(turn.ts)}] ${speaker}: ${turn.text}`;
  }).join(isMarkdown ? '\n\n' : '\n');
  return `${meetingHeader(record)}\n\n${body}${body ? '\n' : ''}`;
}

module.exports = { meetingFilename, meetingHeader, formatMeetingRecord, reasonLabel, localStamp, normalizeTurns };