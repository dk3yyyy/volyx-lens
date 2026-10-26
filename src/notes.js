'use strict';

// Structured meeting notes: the recap mode's answer is parsed into Summary /
// Key Points / Decisions / Action Items / Follow-Up. The prompt lives in
// prompts.js as MODES.recap, so there is no second prompt builder here; this
// module only parses the response.


const HEADERS = [
  ['summary', /^meeting summary\s*:?\s*$/i],
  ['keyPoints', /^key points\s*:?\s*$/i],
  ['decisions', /^decisions\s*:?\s*$/i],
  ['actionItems', /^action items\s*:?\s*$/i],
  ['followUp', /^follow[- ]up\s*:?\s*$/i],
];

function parseNotes(text) {
  const out = { summary: '', keyPoints: [], decisions: [], actionItems: [], followUp: [] };
  if (!text || !text.trim()) return out;

  const lines = text.split(/\r?\n/);
  let cur = null;
  const buckets = { summary: [], keyPoints: [], decisions: [], actionItems: [], followUp: [] };

  for (const raw of lines) {
    const line = raw.trim();
    const matched = HEADERS.find(([, re]) => re.test(line));
    if (matched) { cur = matched[0]; continue; }
    if (!cur) continue;
    if (!line) { cur = null; continue; }
    buckets[cur].push(line);
  }

  for (const [k, arr] of Object.entries(buckets)) {
    if (k === 'summary') {
      out.summary = arr.join(' ').trim();
      continue;
    }
    out[k] = arr
      .map((l) => l
        .replace(/^[-*•]\s*/, '')
        .replace(/^\[[^\]]*\]\s*/, '')
        .replace(/^[0-9]+[.)]\s*/, '')
        .trim())
      .filter(Boolean);
  }

  const anything = Object.values(buckets).some((a) => a.length);
  if (!anything && text.trim()) out.summary = text.trim();

  return out;
}

module.exports = { parseNotes, HEADERS };
