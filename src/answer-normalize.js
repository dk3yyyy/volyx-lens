'use strict';

// Answer text is model output, so it needs a guarantee, not a request. The
// prompt asks for no em dashes and straight quotes (see answer-style.js), but a
// model will still occasionally emit them, and an em dash is the most visible
// tell that a paragraph came out of a model.
//
// The hard constraint is every span that has to stay byte-exact. A fenced block
// can hold a real string, "--flag" is a CLI argument, and 1-2 may be a range the
// user is about to run. The same is true of an inline code span, an indented
// code block, and a URL: the renderer shows inline code as code and the Copy
// button hands the user the raw text, so a rewritten command is worse than a
// stray dash. Those spans are copied through untouched and only the prose
// between them is rewritten.

const EM_DASH = '\u2014';
const EN_DASH = '\u2013';

// A dash directly between two digits is a numeric range, and a comma there
// would read as "2019, 2020" (two items) instead of a span. Lookarounds make
// chains such as 2019–2020–2021 convert in one pass; a consuming pattern would
// skip the second dash because it shares a digit with the first match.
const DIGIT_RANGE_DASH = /(?<=\d)[\u2014\u2013](?=\d)/g;

const ANY_DASH = /[\u2014\u2013]/g;
const CURLY_DOUBLE_QUOTES = /[\u201C\u201D]/g;
const CURLY_SINGLE_QUOTES = /[\u2018\u2019]/g;

// A fence opens with three or more backticks at the start of a line, optionally
// indented (models indent fences inside list items), optionally followed by a
// language tag or other info string. The info string may not contain a
// backtick, which is how CommonMark tells a fence from a prose line that opens
// with an inline code span.
const FENCE_OPEN = /^[ \t]*(`{3,})[^`\r\n]*\r?$/;

// A fence closes on a line that is nothing but backticks and whitespace. The
// closing run must be at least as long as the opening one, so a three-backtick
// line inside a four-backtick fence is content, not a closing delimiter.
const FENCE_CLOSE = /^[ \t]*(`{3,})[ \t\r]*$/;

// A markdown table row: pipes at both ends. Column padding is significant, and
// a lone dash cell is an empty placeholder rather than punctuation, so the
// whole row is copied through. Running the prose rules over it would turn
// "| Owner | — |" into "| Owner | , |" and collapsing doubled spaces would
// destroy the column alignment.
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*\r?$/;

// A URL runs from its scheme to the next whitespace. A dash inside a path or a
// query string is part of the address, so it is never prose punctuation.
const URL_TOKEN = /https?:\/\/\S*/gi;

// Indented code is four spaces or a tab. The pattern alone is not enough: a
// four-space line is also what a wrapped paragraph or a list continuation looks
// like, and Markdown itself will not start an indented code block in the middle
// of a paragraph. Line context decides; see normalizeAnswerText.
const INDENTED_CODE = /^(?: {4,}|\t)/;

// Replacing a dash with ", " can leave artifacts behind: " ,", ",,", "  ", and
// ", .". Each rule only shortens the string, so iterating to a fixed point
// always terminates and keeps the whole function idempotent.
const COLLAPSE_RULES = [
  [/[ \t]+,/g, ','], // "one , two" -> "one, two"
  [/,{2,}/g, ','], // "one,, two" -> "one, two"
  [/ {2,}/g, ' '], // "one,  two" -> "one, two"
  [/, \./g, '.'], // "one, ." -> "one."
];

function collapseArtifacts(text) {
  let out = text;
  for (;;) {
    const before = out;
    for (const [pattern, replacement] of COLLAPSE_RULES) {
      out = out.replace(pattern, replacement);
    }
    if (out === before) return out;
  }
}

// Only prose is rewritten. `text` here is one run of a line that contains no
// protected span, so the rules cannot reach into code or a URL.
function normalizeProse(text) {
  let out = text.replace(DIGIT_RANGE_DASH, '-');
  out = out.replace(ANY_DASH, ', ');
  out = out.replace(CURLY_DOUBLE_QUOTES, '"').replace(CURLY_SINGLE_QUOTES, "'");
  return collapseArtifacts(out);
}

// An inline code span opens on a run of backticks and closes on a run of the
// same width, so a wider run (used when the code itself contains backticks) is
// inline code too, not a fence. Fences are matched line by line before a line is
// segmented, and their content is never segmented, so a run seen here is never a
// fence delimiter.
function nextBacktickRun(body, from) {
  const index = body.indexOf('`', from);
  if (index === -1) return null;
  let end = index + 1;
  while (body[end] === '`') end += 1;
  return { index, width: end - index };
}

// The closing delimiter has to be a run of exactly the same width as the
// opener, which is why "`a``b`" closes on the last backtick instead of the
// middle of the double run. An opener with no matching closer is a literal
// backtick, not code.
function findClosingRun(body, from, width) {
  let index = body.indexOf('`', from);
  while (index !== -1) {
    let end = index + 1;
    while (body[end] === '`') end += 1;
    if (end - index === width) return index;
    index = body.indexOf('`', end);
  }
  return -1;
}

// Split a line body into prose and protected runs, in one left-to-right pass,
// and rewrite only the prose. Segment order is preserved and the separators are
// never part of a prose run, so a protected run comes out byte-identical.
function normalizeLineBody(body) {
  let out = '';
  let proseStart = 0;
  let pos = 0;

  // A width whose opener found no closer anywhere later in the line cannot be
  // closed by any later opener either. Remembering that keeps repeated failed
  // scans from making a pathological line quadratic.
  const unmatchedWidths = new Set();

  const flushProse = (end) => {
    if (end > proseStart) out += normalizeProse(body.slice(proseStart, end));
  };

  while (pos < body.length) {
    const tick = nextBacktickRun(body, pos);

    URL_TOKEN.lastIndex = pos;
    const url = URL_TOKEN.exec(body);
    const urlIndex = url ? url.index : -1;

    if (!tick && urlIndex === -1) break;

    // Take whichever starts first. A backtick before a URL means the URL is
    // sample text inside a code span; a URL before a backtick means the
    // backtick is part of the address, and the URL wins.
    if (!tick || (urlIndex !== -1 && urlIndex < tick.index)) {
      flushProse(urlIndex);
      out += url[0];
      pos = urlIndex + url[0].length;
      proseStart = pos;
      continue;
    }

    const width = tick.width;
    if (unmatchedWidths.has(width)) {
      pos = tick.index + width;
      continue;
    }

    const close = findClosingRun(body, tick.index + width, width);
    if (close === -1) {
      unmatchedWidths.add(width);
      pos = tick.index + width;
      continue;
    }

    flushProse(tick.index);
    out += body.slice(tick.index, close + width);
    pos = close + width;
    proseStart = pos;
  }

  flushProse(body.length);
  return out;
}

// Indentation is a line's structure, not an artifact of dash replacement, so it
// is kept as-is even when it is wider than one space; the requested "doubled
// spaces become one" rule applies to the prose itself. Only the body is
// segmented, so a code span that starts the line is still copied through.
function normalizeProseLine(line) {
  const indent = /^[ \t]*/.exec(line)[0];
  const body = line.slice(indent.length);
  if (!body) return line;
  return indent + normalizeLineBody(body);
}

/**
 * Rewrite model prose so it follows the answer style: no em/en dashes, straight
 * quotes only. Fenced code blocks (delimiters and language tag included),
 * inline code spans, indented code blocks, markdown table rows, and URLs are
 * guaranteed to survive byte for byte. Non-string input is returned as-is.
 *
 * @param {unknown} text
 * @returns {unknown} the normalised text, or the original value when not a string
 */
function normalizeAnswerText(text) {
  if (typeof text !== 'string') return text;
  if (text === '') return '';

  const lines = text.split('\n');
  let openFenceWidth = 0;
  // An indented code block stays open across blank lines and ends at the next
  // line that is not indented, the way Markdown reads it.
  let inIndentedCode = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (openFenceWidth !== 0) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1].length >= openFenceWidth) openFenceWidth = 0;
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open) {
      openFenceWidth = open[1].length;
      inIndentedCode = false;
      continue;
    }

    if (line.trim() === '') continue;

    // Only a blank line (or the start of the text) can open an indented code
    // block: Markdown does not let one interrupt a paragraph, so a four-space
    // line right after prose is a wrapped continuation, and a list continuation
    // looks identical. Both are normalised as prose, which is also how the
    // renderer treats them.
    if (INDENTED_CODE.test(line) && (inIndentedCode || i === 0 || lines[i - 1].trim() === '')) {
      inIndentedCode = true;
      continue;
    }
    inIndentedCode = false;

    // Column padding and a lone dash cell are table structure, not prose.
    if (TABLE_ROW.test(line)) continue;

    lines[i] = normalizeProseLine(line);
  }

  // Joining the original line separators back means fences (and prose lines
  // already in the right shape) are byte-identical to the input, including CRLF
  // line endings and trailing whitespace.
  return lines.join('\n');
}

module.exports = { normalizeAnswerText };
