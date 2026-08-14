// Opt-in automatic assistance. Question detection itself is always local and
// manual ("Draft answer"); this policy decides whether a detected question may
// also trigger an answer without the user pressing the button. Defaults keep
// automatic generation off.
function createAutoAssistPolicy({
  cooldownMs = 60000,
  maxRecent = 5,
  enabled = false,
} = {}) {
  const recent = [];

  function normalize(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 500);
  }

  // Returns { shouldAnswer, reason } where reason is one of:
  // disabled | empty | busy | not-capturing | duplicate | cooldown | ok
  function evaluate({ question, now = Date.now(), busy = false, capturing = true } = {}) {
    if (!enabled) return { shouldAnswer: false, reason: 'disabled' };
    const key = normalize(question);
    if (!key) return { shouldAnswer: false, reason: 'empty' };
    if (busy) return { shouldAnswer: false, reason: 'busy' };
    if (!capturing) return { shouldAnswer: false, reason: 'not-capturing' };
    const windowStart = now - cooldownMs;
    const insideWindow = recent.filter((entry) => entry.at >= windowStart);
    if (insideWindow.some((entry) => entry.text === key)) return { shouldAnswer: false, reason: 'duplicate' };
    if (insideWindow.length > 0) return { shouldAnswer: false, reason: 'cooldown' };
    return { shouldAnswer: true, reason: 'ok' };
  }

  function record(question, now = Date.now()) {
    recent.push({ text: normalize(question), at: now });
    while (recent.length > maxRecent) recent.shift();
  }

  function reset() {
    recent.length = 0;
  }

  return { evaluate, record, reset };
}

module.exports = { createAutoAssistPolicy };
