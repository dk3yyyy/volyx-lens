'use strict';

const { escapeSubtitle } = require('./transcript-tools');

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
  const extension = ['txt', 'md', 'json', 'srt', 'vtt'].includes(format) ? format : 'md';
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `volyx-lens-meeting-${stamp}.${extension}`;
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

// "Them" is a placeholder. When the user names the other speaker, that name is
// what the transcript, the subtitles and the notes should call them.
function speakerName(turn, record = {}) {
  if (turn && turn.channel === 'you') return 'You';
  const named = record && record.participant ? String(record.participant).trim() : '';
  return named || 'Them';
}

function meetingHeader(record = {}, { cleaned = false } = {}) {
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const lines = [`# Volyx Lens ${record.meeting === true ? 'meeting' : 'session'}`];
  if (Number.isFinite(record.startedAt)) lines.push(`\nStarted: ${localStamp(record.startedAt)}`);
  if (Number.isFinite(record.endedAt)) lines.push(`Ended: ${localStamp(record.endedAt)}`);
  lines.push(`Session end: ${reasonLabel(record.reason)}`);
  lines.push(`Turns: ${turns.length}`);
  if (record.meeting === true) lines.push('Meeting: detected as a two-sided conversation');
  if (record.participant) lines.push(`Participants: You, ${String(record.participant).trim()}`);
  if (cleaned) lines.push('Transcript: cleaned copy, wording repaired from speech recognition; the raw transcript is kept in the app');
  return lines.join('\n');
}

/**
 * Pick the turn list an export should print. A cleaned copy is used only when
 * it is parallel to the saved turns (same length, non-empty text per turn), so
 * an export can never silently lose or reorder a turn. Raw wording is the
 * fallback and stays authoritative.
 */
function resolveTurns(record = {}, { source = 'auto' } = {}) {
  const raw = normalizeTurns(record);
  if (source === 'raw') return { turns: raw, cleaned: false };
  const cleaned = record && record.cleaned && Array.isArray(record.cleaned.texts) ? record.cleaned.texts : null;
  if (!cleaned || !cleaned.length || cleaned.length !== raw.length) return { turns: raw, cleaned: false };
  const merged = raw.map((turn, index) => {
    const text = String(cleaned[index] || '').trim().slice(0, 12000);
    return text ? { channel: turn.channel, text, ts: turn.ts } : turn;
  });
  return { turns: merged, cleaned: true };
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

function formatMeetingRecordSrt(record = {}, { source = 'auto' } = {}) {
  const { turns } = resolveTurns(record, { source });
  const blocks = [];
  turns.forEach((turn, index) => {
    const speaker = speakerName(turn, record);
    const start = Number.isFinite(turn.ts) ? turn.ts : 0;
    const end = start + 4000;
    blocks.push(`${index + 1}\n${srtTimecode(start)} --> ${srtTimecode(end)}\n${speaker}: ${escapeSubtitle(turn.text)}`);
  });
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

function formatMeetingRecordVtt(record = {}, { source = 'auto' } = {}) {
  const { turns } = resolveTurns(record, { source });
  const blocks = ['WEBVTT\n'];
  turns.forEach((turn) => {
    const speaker = speakerName(turn, record);
    const start = Number.isFinite(turn.ts) ? turn.ts : 0;
    const end = start + 4000;
    blocks.push(`${vttTimecode(start)} --> ${vttTimecode(end)}\n${speaker}: ${escapeSubtitle(turn.text)}`);
  });
  return blocks.join('\n\n') + (turns.length ? '\n' : '');
}

function formatMeetingRecord(record = {}, format = 'md', exportedAt = Date.now(), { source = 'auto' } = {}) {
  const { turns, cleaned } = resolveTurns(record, { source });
  if (format === 'json') {
    const payload = {
      version: 1,
      id: record.id || null,
      reason: record.reason || null,
      meeting: record.meeting === true,
      startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
      endedAt: Number.isFinite(record.endedAt) ? record.endedAt : null,
      exportedAt: new Date(exportedAt).toISOString(),
      turns: normalizeTurns(record),
    };
    // JSON keeps the raw transcript authoritative and carries the readable copy
    // beside it, so a consumer can diff what was said against what was cleaned.
    const stored = record && record.cleaned;
    if (stored && Array.isArray(stored.texts) && stored.texts.length) {
      payload.cleaned = {
        version: 1,
        at: Number.isFinite(stored.at) ? stored.at : null,
        model: stored.model || null,
        provider: stored.provider || null,
        texts: stored.texts.map((text) => String(text || '')),
      };
    }
    return JSON.stringify(payload, null, 2) + '\n';
  }
  // Subtitles stay literal: SRT has no comment slot and VTT comments render
  // differently per player, so a repaired subtitle file could look like an
  // exact transcript. Markdown, TXT, and JSON carry the provenance instead.
  if (format === 'srt') return formatMeetingRecordSrt(record, { source: 'raw' });
  if (format === 'vtt') return formatMeetingRecordVtt(record, { source: 'raw' });
  const isMarkdown = format === 'md';
  const body = turns.map((turn) => {
    const speaker = speakerName(turn, record);
    if (isMarkdown) return `- **${timeLabel(turn.ts)} · ${speaker}:** ${turn.text.replace(/\n/g, '\n  ')}`;
    return `[${timeLabel(turn.ts)}] ${speaker}: ${turn.text}`;
  }).join(isMarkdown ? '\n\n' : '\n');
  return `${meetingHeader(record, { cleaned })}\n\n${body}${body ? '\n' : ''}`;
}

module.exports = { meetingFilename, meetingHeader, formatMeetingRecord, formatMeetingRecordSrt, formatMeetingRecordVtt, reasonLabel, localStamp, normalizeTurns, resolveTurns, speakerName, srtTimecode, vttTimecode };