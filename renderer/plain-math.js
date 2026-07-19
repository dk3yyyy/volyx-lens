(function exposePlainMath(root, factory) {
  const normalizePlainMath = factory();
  if (typeof module === 'object' && module.exports) module.exports = { normalizePlainMath };
  if (root) root.volyxLensPlainMath = normalizePlainMath;
})(typeof window !== 'undefined' ? window : null, () => {
  const SYMBOLS = Object.freeze({
    cdot: '·', times: '×', leq: '≤', geq: '≥', neq: '≠', approx: '≈',
    infinity: '∞', infty: '∞', rightarrow: '→', leftarrow: '←',
  });

  function normalizePlainMath(value) {
    let text = String(value || '');
    // Only prose passes through this function; fenced code is handled separately.
    text = text
      .replace(/\\(?:hat|widehat)\{([^{}]+)\}/g, '$1-hat')
      .replace(/\\vec\{([^{}]+)\}/g, '$1-vector')
      .replace(/\\bar\{([^{}]+)\}/g, '$1-bar')
      .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)')
      .replace(/\\(?:mathbf|mathrm|text)\{([^{}]*)\}/g, '$1')
      .replace(/_\{([^{}]+)\}/g, '_$1')
      .replace(/\^\{([^{}]+)\}/g, '^$1')
      .replace(/\\\(([^\n]*?)\\\)/g, '$1')
      .replace(/\\\[([^\n]*?)\\\]/g, '$1')
      .replace(/\\(cdot|times|leq|geq|neq|approx|infinity|infty|rightarrow|leftarrow)\b/g, (_match, name) => SYMBOLS[name])
      .replace(/\\,/g, ' ')
      .replace(/\\([_%])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ');
    return text;
  }

  return normalizePlainMath;
});
