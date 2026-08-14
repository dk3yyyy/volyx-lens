const QUESTION_START = /^(?:who|what|when|where|why|how|which|whose|can|could|would|will|do|does|did|is|are|was|were|have|has|had|should|may|might|tell me|walk me through|explain|describe)\b/i;
const EMBEDDED_QUESTION = /\b(?:i(?:'d| would) like to know|i want to know|could you|can you|would you|tell me|walk me through|explain)\b/i;

function cleanQuestion(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').slice(-1000);
}

function questionCandidate(text) {
  const clean = cleanQuestion(text);
  if (!clean) return null;
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  return (sentences[sentences.length - 1] || clean).trim();
}

function detectQuestion(text) {
  const candidate = questionCandidate(text);
  if (!candidate) return null;
  const words = candidate.match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length < 3) return null;
  const questionLike = candidate.endsWith('?') || QUESTION_START.test(candidate) || EMBEDDED_QUESTION.test(candidate);
  if (!questionLike) return null;
  return candidate.slice(-500);
}

// Rough local confidence heuristic (0..1) used to gate opt-in automatic
// answers. Explicit question words and a closing question mark raise the
// score; long run-on turns lower it. Manual "Draft answer" is unaffected.
function estimateQuestionConfidence(text) {
  const candidate = questionCandidate(text);
  if (!candidate) return 0;
  let score = 0;
  if (candidate.endsWith('?')) score += 0.5;
  if (QUESTION_START.test(candidate)) score += 0.4;
  if (EMBEDDED_QUESTION.test(candidate)) score += 0.2;
  const words = candidate.match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length >= 3) score += 0.1;
  if (words.length > 28) score -= 0.15;
  return Math.min(1, Math.max(0, score));
}

module.exports = { detectQuestion, cleanQuestion, questionCandidate, estimateQuestionConfidence };
