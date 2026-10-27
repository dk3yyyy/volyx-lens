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

function channelLuminance(hex) {
  return luminance(hex);
}

function compositeOver(hex, alpha, background) {
  const fg = hex.replace('#', '').match(/../g).map((pair) => parseInt(pair, 16));
  const bg = background.replace('#', '').match(/../g).map((pair) => parseInt(pair, 16));
  const mixed = fg.map((value, index) => Math.round(value * alpha + bg[index] * (1 - alpha)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function glassSurface() {
  const rule = styles.match(/\.glass\s*\{([\s\S]*?)\}/);
  assert.ok(rule, 'the glass surface is defined');
  const match = rule[1].match(/background:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)/);
  assert.ok(match, 'the glass surface declares a translucent background');
  const [red, green, blue, alpha] = [match[1], match[2], match[3], Number(match[4])];
  const base = `#${[red, green, blue].map((value) => Number(value).toString(16).padStart(2, '0')).join('')}`;
  return { base, alpha };
}

test('the panel keeps its alpha high enough to hold text over bright content', () => {
  const { alpha } = glassSurface();
  assert.ok(alpha >= 0.85, `the glass panel must stay opaque enough over a white slide (got ${alpha})`);
});

test('secondary text and danger text clear 4.5:1 over a bright slide', () => {
  const { base, alpha } = glassSurface();
  // A white slide is the worst case this overlay sits on: a light deck, a doc, a
  // bright IDE. Composite the panel over it and measure the text on top.
  const surface = compositeOver(base, alpha, '#FFFFFF');
  for (const tokenName of ['tx-mut', 'tx-2', 'danger']) {
    const value = token(tokenName);
    assert.ok(value, `${tokenName} is defined`);
    const ratio = contrast(value, surface);
    assert.ok(ratio >= 4.5, `${tokenName} clears 4.5:1 over bright content (got ${ratio.toFixed(2)}:1 on ${surface})`);
  }
  assert.ok(channelLuminance(surface) > 0, 'the composite is a real colour');
});

test('the inactive palette clears the non-text and text floors', () => {
  const inactive = styles.match(/body\.window-inactive\s*\{([\s\S]*?)\}/)[1];
  const surface0 = token('surface-0');
  const surface1 = token('surface-1');
  const accent = inactive.match(/--accent:\s*(#[0-9A-Fa-f]{6})/)[1];
  const accentHi = inactive.match(/--accent-hi:\s*(#[0-9A-Fa-f]{6})/)[1];
  for (const [name, value] of [['accent', accent], ['accent-hi', accentHi]]) {
    const onPanel = contrast(value, surface0);
    const onRaised = contrast(value, surface1);
    assert.ok(onPanel >= 4.5, `inactive ${name} clears 4.5:1 on the panel (got ${onPanel.toFixed(2)}:1)`);
    assert.ok(onRaised >= 3, `inactive ${name} clears the 3:1 non-text floor (got ${onRaised.toFixed(2)}:1)`);
  }
  for (const name of ['danger', 'live']) {
    const value = inactive.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))[1];
    const ratio = contrast(value, surface1);
    assert.ok(ratio >= 4.5, `inactive ${name} clears 4.5:1 when the window is unfocused (got ${ratio.toFixed(2)}:1)`);
  }
});
