'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');

function block(header) {
  const match = styles.match(new RegExp(`@media \\(${header}\\)\\s*\\{([\\s\\S]*?)\\n\\}\\n`));
  assert.ok(match, `the ${header} block exists`);
  return match[1];
}

function token(name, source = styles) {
  const match = source.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  return match ? match[1] : null;
}

function luminance(hex) {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function blurSelectors() {
  const selectors = new Set();
  // Comments sit inside the rule text, so they have to go before the selector
  // can be read: a trailing block comment otherwise becomes part of the name.
  const clean = styles.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selector, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/backdrop-filter:\s*blur\(/.test(body)) continue;
    for (const part of selector.split(',')) {
      const name = part.replace(/\s+/g, ' ').trim();
      if (name) selectors.add(name);
    }
  }
  return [...selectors];
}

test('every blurred surface becomes solid when transparency is reduced', () => {
  const reduced = block('prefers-reduced-transparency: reduce');
  const selectors = blurSelectors();
  assert.ok(selectors.length >= 3, 'the app has several blurred surfaces to cover');
  for (const selector of selectors) {
    assert.ok(reduced.includes(selector), `${selector} is made solid when transparency is reduced`);
  }
  assert.doesNotMatch(reduced, /blur\(/, 'nothing in the reduced block still blurs');
  assert.match(reduced, /backdrop-filter:\s*none/);
});

test('the reduced transparency surfaces are painted, not left see-through', () => {
  const reduced = block('prefers-reduced-transparency: reduce');
  for (const surface of ['#toolbar', '.glass', '#settings', '#onboard']) {
    const rule = reduced.match(new RegExp(`${surface.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\}`));
    assert.ok(rule, `${surface} has a rule in the reduced block`);
    assert.match(rule[1], /background:\s*#[0-9A-Fa-f]{6}/, `${surface} gets an opaque background`);
  }
});

test('increase contrast raises the muted text above the accessibility floor', () => {
  const more = block('prefers-contrast: more');
  const surface = token('surface-0');
  const normalMuted = token('tx-mut');
  const moreMuted = token('tx-mut', more);
  assert.ok(moreMuted, 'the contrast block sets its own muted text colour');
  assert.ok(luminance(moreMuted) > luminance(normalMuted), 'the muted text gets brighter, not just different');
  const ratio = contrast(moreMuted, surface);
  assert.ok(ratio >= 7, `muted text clears 7:1 with increase contrast on (got ${ratio.toFixed(2)}:1)`);
  for (const name of ['tx-1', 'tx-2']) {
    const value = token(name, more);
    assert.ok(value && contrast(value, surface) >= 7, `${name} clears 7:1 with increase contrast on`);
  }
});

test('increase contrast strengthens structure instead of relying on colour', () => {
  const more = block('prefers-contrast: more');
  assert.match(more, /--bd-hair:\s*rgba\(220,226,255,0\.42\)/, 'the hairline border gets a visible alpha');
  assert.match(more, /--bd-strong:/);
  assert.match(more, /:focus-visible\s*\{[^}]*outline:\s*2px solid/, 'focus is drawn with a solid ring');
});

test('the brighter palette survives the inactive window state', () => {
  const more = block('prefers-contrast: more');
  assert.match(more, /body\.window-inactive\s*\{/, 'body.window-inactive would otherwise outrank the :root override');
  assert.match(more, /body\.window-inactive\s*\{[^}]*--tx-mut:/);
});
