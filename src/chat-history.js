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

  function prune() {
    const characters = () => exchanges.reduce((total, exchange) => total + exchange.user.length + exchange.assistant.length, 0);
    while (exchanges.length && ((exchanges.length * 2) > historyTurnLimit || characters() > characterLimit)) exchanges.shift();
  }

  return {
    addExchange(user, assistant) {
      const cleanUser = cleanText(user);
      const cleanAssistant = cleanText(assistant);
      if (!cleanUser || !cleanAssistant || historyTurnLimit === 0) return false;
      exchanges.push({ user: cleanUser, assistant: cleanAssistant });
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
