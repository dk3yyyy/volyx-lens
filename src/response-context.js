'use strict';

const ALWAYS_SCREEN_MODES = new Set(['assist', 'assist-screen', 'leetcode']);
const CONVERSATION_REQUIRED_MODES = new Set(['assist-conversation', 'say', 'followup', 'recap']);
const SCREEN_REFERENCE = /(^\s*(?:screen|screenshot)\s*:)|\b(?:on|from|in)\s+(?:my|the|this|current)\s+(?:screen|screenshot|image|diagram|window|page)\b|\b(?:this|current)\s+(?:screen|screenshot|image|diagram|window|page|code|error|problem)\b|\b(?:look at|analyze|check|read|use|capture|inspect|view)\s+(?:my|the|this|current)?\s*(?:screen|screenshot|image|diagram|window|page)\b|\b(?:visible|shown|displayed)\b.*\b(?:screen|screenshot|image|diagram|window|page)\b|\bshown (?:here|above|on[- ]screen)\b/i;
const SOURCE_UNCERTAINTY_RULE = 'If supplied source context is missing, unclear, ambiguous, conflicting, or insufficient, say exactly what is uncertain and ask for the smallest missing detail when useful. Do not guess, invent visible details, or present an inference as fact.';

function shouldAttachScreen({ mode, userText = '' } = {}) {
  if (ALWAYS_SCREEN_MODES.has(mode)) return true;
  if (mode !== 'ask') return false;
  return SCREEN_REFERENCE.test(String(userText || ''));
}

function missingContextMessage({ mode, transcript = [] } = {}) {
  if (!CONVERSATION_REQUIRED_MODES.has(mode)) return '';
  const hasConversation = Array.isArray(transcript) && transcript.some((turn) => String((turn && turn.text) || '').trim());
  if (hasConversation) return '';
  if (mode === 'recap') return 'There is no conversation to recap yet. Start Listening and capture some conversation first.';
  return 'No conversation has been captured yet. Start Listening and wait for some speech before using this action.';
}

module.exports = { shouldAttachScreen, missingContextMessage, SOURCE_UNCERTAINTY_RULE };
