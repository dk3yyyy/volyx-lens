'use strict';

// Answer text is model output, so it needs a guarantee, not a request. The
// prompt asks for no em dashes and straight quotes (see answer-style.js), but a
// model will still occasionally emit them, and an em dash is the most visible
// tell that a paragraph came out of a model.
//
// The hard constraint is the fenced code block. Inside a fence an em dash can
// be a real character in a string, "--flag" is a CLI argument, and 1-2 may be a
// range the user is about to run. Fences are therefore copied through byte for
// byte and only prose is rewritten.

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

// Only the body of a prose line is rewritten. Indentation is a line's
// structure, not an artifact of dash replacement, so it is kept as-is even when
// it is wider than one space; the requested "doubled spaces become one" rule
// applies to the prose itself.
function normalizeProseLine(line) {
  const indent = /^[ \t]*/.exec(line)[0];
  const body = line.slice(indent.length);
  if (!body) return line;

  let out = body.replace(DIGIT_RANGE_DASH, '-');
  out = out.replace(ANY_DASH, ', ');
  out = out.replace(CURLY_DOUBLE_QUOTES, '"').replace(CURLY_SINGLE_QUOTES, "'");
  return indent + collapseArtifacts(out);
}

/**
 * Rewrite model prose so it follows the answer style: no em/en dashes, straight
 * quotes only. Fenced code blocks, including their delimiters and language tag,
 * are guaranteed to survive byte for byte. Non-string input is returned as-is.
 *
 * @param {unknown} text
 * @returns {unknown} the normalised text, or the original value when not a string
 */
function normalizeAnswerText(text) {
  if (typeof text !== 'string') return text;
  if (text === '') return '';

  const lines = text.split('\n');
  let openFenceWidth = 0;

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
      continue;
    }

    lines[i] = normalizeProseLine(line);
  }

  // Joining the original line separators back means fences (and prose lines
  // already in the right shape) are byte-identical to the input, including CRLF
  // line endings and trailing whitespace.
  return lines.join('\n');
}

module.exports = { normalizeAnswerText };
