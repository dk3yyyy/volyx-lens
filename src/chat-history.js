'use strict';

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_CHARACTERS = 12000;

function cleanText(value) {
  return String(value || '').trim();
}

function createChatHistory({ maxTurns = DEFAULT_MAX_TURNS, maxCharacters = DEFAULT_MAX_CHARACTERS } = {}) {
  const parsedMaxTurns = Number(maxTurns);
  const finiteMaxTurns = Number.isFinite(parsedMaxTurns) ? parsedMaxTurns : DEFAULT_MAX_TURNS;
  const parsedMaxCharacters = Number(maxCharacters);
  const finiteMaxCharacters = Number.isFinite(parsedMaxCharacters) ? parsedMaxCharacters : DEFAULT_MAX_CHARACTERS;
  const historyTurnLimit = Math.max(0, Math.floor((Math.max(1, finiteMaxTurns) - 1) / 2) * 2);
  const characterLimit = Math.max(1, finiteMaxCharacters);
  const exchanges = [];

  // A single long answer used to consume the whole budget in prune(), which
  // shifted every exchange including the one just added and left the thread with
  // no history at all. Each answer is capped before it is stored, so one answer
  // can own at most half the budget and the rest of the conversation survives.
  const perAnswerLimit = Math.max(200, Math.floor(characterLimit / 2));
  const TRIM_MARK = ' […]';

  function capAnswer(text) {
    if (text.length <= perAnswerLimit) return text;
    return text.slice(0, Math.max(1, perAnswerLimit - TRIM_MARK.length)).trimEnd() + TRIM_MARK;
  }

  function prune() {
    const characters = () => exchanges.reduce((total, exchange) => total + exchange.user.length + exchange.assistant.length, 0);
    while (exchanges.length && ((exchanges.length * 2) > historyTurnLimit || characters() > characterLimit)) exchanges.shift();
  }

  return {
    addExchange(user, assistant) {
      const cleanUser = cleanText(user);
      const cleanAssistant = cleanText(assistant);
      if (!cleanUser || !cleanAssistant || historyTurnLimit === 0) return false;
      exchanges.push({ user: cleanUser, assistant: capAnswer(cleanAssistant) });
      prune();
      return true;
    },
    turnsFor(currentUserText) {
      const current = cleanText(currentUserText);
      const turns = exchanges.flatMap((exchange) => [
        { role: 'user', text: exchange.user },
        { role: 'assistant', text: exchange.assistant },
      ]);
      if (current) turns.push({ role: 'user', text: current });
      return turns;
    },
    clear() { exchanges.length = 0; },
    size() { return exchanges.length; },
  };
}

module.exports = { createChatHistory, DEFAULT_MAX_TURNS, DEFAULT_MAX_CHARACTERS };
