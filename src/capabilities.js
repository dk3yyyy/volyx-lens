function planScreenInput({ mode, needsScreen, supportsVision, providerLabel = 'This provider' }) {
  if (!needsScreen) return { capture: false, error: null, notice: null };
  if (supportsVision) return { capture: true, error: null, notice: null };

  if (mode === 'leetcode') {
    return {
      capture: false,
      error: `${providerLabel} is text-only. Choose a vision-capable provider to solve what is on screen.`,
      notice: null,
    };
  }

  return {
    capture: false,
    error: null,
    notice: `${providerLabel} is text-only, so Volyx Lens will continue without a screenshot.`,
  };
}

module.exports = { planScreenInput };
