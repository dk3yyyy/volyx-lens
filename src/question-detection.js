const QUESTION_START = /^(?:who|what|when|where|why|how|which|whose|can|could|would|will|do|does|did|is|are|was|were|have|has|had|should|may|might|tell me|walk me through|explain|describe)\b/i;
const EMBEDDED_QUESTION = /\b(?:i(?:'d| would) like to know|i want to know|could you|can you|would you|tell me|walk me through|explain)\b/i;

function cleanQuestion(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').slice(-1000);
}

function detectQuestion(text) {
  const clean = cleanQuestion(text);
  if (!clean) return null;
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const candidate = (sentences[sentences.length - 1] || clean).trim();
  const words = candidate.match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length < 3) return null;
  const questionLike = candidate.endsWith('?') || QUESTION_START.test(candidate) || EMBEDDED_QUESTION.test(candidate);
  if (!questionLike) return null;
  return candidate.slice(-500);
}

module.exports = { detectQuestion, cleanQuestion };
