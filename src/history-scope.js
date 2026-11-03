'use strict';

// Which requests belong to the typed conversation the user is having.
//
// Assist, Say, and a typed question all answer the same person in the same
// thread, so they share one history. Before this existed only `ask` recorded a
// turn, so pressing Assist and then typing a follow-up started the model from
// nothing: it saw no previous question and no previous answer.
//
// Auto-assist fires on its own when a question is detected, and slide review is
// an internal step, so neither may push turns into that thread.

// An allowlist, not a denylist: a future internal mode added without thinking
// about history must default to staying out of the thread rather than silently
// being replayed into the user's next question.
const CONVERSATIONAL_MODES = new Set([
  'ask',
  'assist',
  'assist-screen',
  'assist-conversation',
  'say',
  'followup',
  'recap',
  'leetcode',
]);

function shouldKeepHistory(mode) {
  return CONVERSATIONAL_MODES.has(String(mode == null ? '' : mode));
}

// A press of Assist carries no typed text, but the model still needs a user turn
// to hang the answer on. The action label stands in for it, and the mode name is
// the last resort so the thread never gains an empty user turn.
function userTextForHistory({ mode, text, label } = {}) {
  const typed = String(text == null ? '' : text).trim();
  if (typed) return typed;
  const named = String(label == null ? '' : label).trim();
  if (named) return named;
  const key = String(mode == null ? '' : mode).trim();
  if (!key) return 'Request';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

module.exports = { shouldKeepHistory, userTextForHistory, CONVERSATIONAL_MODES };
