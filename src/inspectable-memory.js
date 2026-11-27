'use strict';

const MAX_MEMORY_CHARS = 4000;
const MAX_SEARCH_RESULTS = 5;
const MAX_MEMORY_ENTRY_CONTEXT_CHARS = 1000;
const MAX_MEMORY_CONTEXT_CHARS = MAX_SEARCH_RESULTS * (MAX_MEMORY_ENTRY_CONTEXT_CHARS + 160);
const MEETING_ID_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;
const MAX_SEARCH_QUERY_CHARS = 4000;
const SEARCH_TERM_PATTERN = /[\p{L}\p{N}_]+/gu;
const SEARCH_STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'doing', 'for', 'from', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'no', 'nor', 'not',
  'of', 'on', 'once', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'same',
  'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'why', 'will', 'with', 'you', 'your', 'yours',
]);

function normalizeMemoryContent(value) {
  const content = String(value == null ? '' : value)
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!content) throw new Error('Memory content cannot be empty.');
  if (content.length > MAX_MEMORY_CHARS) throw new Error(`Memory content must be ${MAX_MEMORY_CHARS} characters or fewer.`);
  return content;
}

function normalizeNotesList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item == null ? '' : item).replace(/\s+/g, ' ').trim()).filter(Boolean)
    : [];
}

function buildMemoryContentFromNotes(notes) {
  if (!notes || typeof notes !== 'object') return '';
  const sections = [];
  const summary = String(notes.summary || '').replace(/\s+/g, ' ').trim();
  if (summary) sections.push(`Summary: ${summary}`);
  for (const [label, key] of [['Key points', 'keyPoints'], ['Decisions', 'decisions'], ['Action items', 'actionItems'], ['Follow-up', 'followUp']]) {
    const items = normalizeNotesList(notes[key]);
    if (items.length) sections.push(`${label}:\n${items.map((item) => `- ${item}`).join('\n')}`);
  }
  return sections.length ? normalizeMemoryContent(sections.join('\n')) : '';
}

function createMeetingMemory({ meetingId, endedAt, notes, existing = null, now = Date.now() } = {}) {
  const id = String(meetingId == null ? '' : meetingId);
  if (!MEETING_ID_PATTERN.test(id) || id === '.' || id === '..') throw new Error('A valid source meeting id is required.');
  const content = buildMemoryContentFromNotes(notes);
  if (!content) throw new Error('Meeting notes do not contain any memory content.');
  const timestamp = Number.isFinite(now) ? now : Date.now();
  return {
    version: 1,
    content,
    enabled: existing && typeof existing.enabled === 'boolean' ? existing.enabled : true,
    source: {
      type: 'meeting-notes',
      meetingId: id,
      endedAt: Number.isFinite(endedAt) ? endedAt : null,
      transcriptSource: ['raw', 'cleaned', 'processed'].includes(notes.source) ? notes.source : 'unknown',
      transcriptHash: typeof notes.sourceHash === 'string' && /^[a-f0-9]{64}$/i.test(notes.sourceHash)
        ? notes.sourceHash.toLowerCase()
        : null,
    },
    createdAt: existing && Number.isFinite(existing.createdAt) ? existing.createdAt : timestamp,
    updatedAt: timestamp,
  };
}

function restoreMeetingMemory(memory, { meetingId, endedAt, now = Date.now() } = {}) {
  if (!memory || memory.version !== 1 || typeof memory.content !== 'string' || typeof memory.enabled !== 'boolean') return null;
  const id = String(meetingId == null ? '' : meetingId);
  if (!MEETING_ID_PATTERN.test(id) || id === '.' || id === '..') return null;
  let content;
  try { content = normalizeMemoryContent(memory.content); } catch { return null; }
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const source = memory.source && typeof memory.source === 'object' ? memory.source : {};
  return {
    version: 1,
    content,
    enabled: memory.enabled,
    source: {
      type: 'meeting-notes',
      meetingId: id,
      endedAt: Number.isFinite(endedAt) ? endedAt : null,
      transcriptSource: ['raw', 'cleaned', 'processed'].includes(source.transcriptSource)
        ? source.transcriptSource
        : 'unknown',
      transcriptHash: typeof source.transcriptHash === 'string' && /^[a-f0-9]{64}$/i.test(source.transcriptHash)
        ? source.transcriptHash.toLowerCase()
        : null,
    },
    createdAt: Number.isFinite(memory.createdAt) ? memory.createdAt : timestamp,
    updatedAt: Number.isFinite(memory.updatedAt) ? memory.updatedAt : timestamp,
  };
}

function memorySearchTerms(query) {
  const tokens = String(query || '').toLowerCase().slice(-MAX_SEARCH_QUERY_CHARS).match(SEARCH_TERM_PATTERN) || [];
  return [...new Set(tokens.filter((term) => term.length >= 2 && !SEARCH_STOPWORDS.has(term)))].slice(0, 16);
}

function hasMemorySearchTerms(query) {
  return memorySearchTerms(query).length > 0;
}

function buildMemorySearchQuery(userText, transcriptText, { maxChars = MAX_SEARCH_QUERY_CHARS } = {}) {
  const budget = Number.isSafeInteger(maxChars) && maxChars >= 2 ? maxChars : MAX_SEARCH_QUERY_CHARS;
  const question = String(userText || '').replace(/\s+/g, ' ').trim();
  const transcript = String(transcriptText || '').replace(/\s+/g, ' ').trim();
  if (!question) return transcript.slice(-budget);
  const questionBudget = Math.min(2000, Math.floor(budget / 2));
  const boundedQuestion = question.slice(0, questionBudget);
  const transcriptBudget = budget - boundedQuestion.length - 1;
  const recentTranscript = transcriptBudget > 0 ? transcript.slice(-transcriptBudget) : '';
  return recentTranscript ? `${boundedQuestion}\n${recentTranscript}` : boundedQuestion;
}

function memoryExcerpt(content, matchStart, limit = MAX_MEMORY_ENTRY_CONTEXT_CHARS) {
  const text = String(content || '');
  const boundedLimit = Number.isSafeInteger(limit) && limit > 2 ? limit : MAX_MEMORY_ENTRY_CONTEXT_CHARS;
  const innerLimit = boundedLimit - 2;
  let start = Math.max(0, Number.isFinite(matchStart) ? matchStart - Math.floor(innerLimit / 4) : 0);
  let end = Math.min(text.length, start + innerLimit);
  if (end - start < innerLimit) start = Math.max(0, end - innerLimit);
  const excerpt = text.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`;
}

function searchMeetingMemories(memories, query, { limit = MAX_SEARCH_RESULTS } = {}) {
  const terms = memorySearchTerms(query);
  if (!terms.length || !Array.isArray(memories)) return [];
  const resultLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_SEARCH_RESULTS) : MAX_SEARCH_RESULTS;
  const minimumMatches = terms.length > 1 ? 2 : 1;
  return memories
    .filter((entry) => entry && entry.memory && entry.memory.enabled === true && entry.memory.version === 1)
    .map((entry) => {
      const content = String(entry.memory.content || '');
      const positions = new Map();
      const pattern = new RegExp(SEARCH_TERM_PATTERN.source, 'gu');
      let token;
      while ((token = pattern.exec(content)) !== null) {
        const term = token[0].toLowerCase();
        if (!positions.has(term)) positions.set(term, token.index);
      }
      const matched = terms.filter((term) => positions.has(term));
      if (matched.length < minimumMatches) return null;
      const matchStart = Math.min(...matched.map((term) => positions.get(term)));
      return {
        meetingId: String(entry.id || ''),
        memory: { ...entry.memory, source: { ...(entry.memory.source || {}) } },
        matchedTerms: matched.length,
        matchedTermList: matched,
        excerpt: memoryExcerpt(content, matchStart),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.matchedTerms - left.matchedTerms
      || (Number(right.memory.updatedAt) || 0) - (Number(left.memory.updatedAt) || 0))
    .slice(0, resultLimit);
}

module.exports = {
  buildMemoryContentFromNotes,
  createMeetingMemory,
  restoreMeetingMemory,
  normalizeMemoryContent,
  searchMeetingMemories,
  hasMemorySearchTerms,
  buildMemorySearchQuery,
  MAX_MEMORY_CHARS,
  MAX_SEARCH_RESULTS,
  MAX_MEMORY_ENTRY_CONTEXT_CHARS,
  MAX_MEMORY_CONTEXT_CHARS,
};
