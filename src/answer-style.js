'use strict';

// One place that defines how a Volyx Lens answer should read. Every provider
// system prompt appends it, so Assist, Recap, meeting notes, and transcript
// cleanup share a voice instead of each drifting toward the house style of
// whatever model happens to be configured.
//
// The dash rule is not cosmetic: an em dash is the most reliable tell that a
// paragraph came out of a model, and it is the one the user sees most often.

const ANSWER_STYLE_RULE = [
  'Write like a person talking, not like a chatbot.',
  'Never use em dashes or en dashes. Use a comma, a full stop, or a colon instead.',
  'Use straight quotes, never curly ones.',
  'Do not open with "Great question", "Certainly", "Sure", or by restating the request.',
  'Do not use "not just X, it is Y" phrasing, and do not force ideas into threes.',
  'Avoid stock AI wording: delve, crucial, pivotal, seamless, robust, leverage, tapestry, landscape, testament, underscore, showcase, foster, myriad, realm.',
  'Prefer short sentences and concrete nouns. Make the point, then stop.',
].join(' ');

// The subset that belongs in a prompt whose job is to reproduce someone else's
// words rather than to write well. Transcript cleanup must keep the speaker's
// register, so it gets the punctuation rules and none of the "be brief" advice:
// a cleaner told to "make the point, then stop" can shorten what was said.
const PUNCTUATION_RULE = [
  'Never use em dashes or en dashes. Use a comma, a full stop, or a colon instead.',
  'Use straight quotes, never curly ones.',
].join(' ');

// Appends the rule unless the prompt already carries it. Prompts are assembled
// from several modules, so without this guard the rule lands twice the moment a
// second layer appends it (it did: the mode prompts and the shared output rule
// both picked it up during the first pass at this change).
function withAnswerStyle(prompt) {
  const text = String(prompt == null ? '' : prompt);
  if (!text.trim()) return ANSWER_STYLE_RULE;
  return text.includes(ANSWER_STYLE_RULE) ? text : `${text}\n\n${ANSWER_STYLE_RULE}`;
}

module.exports = { ANSWER_STYLE_RULE, PUNCTUATION_RULE, withAnswerStyle };
