'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'website', 'styles.css'), 'utf8');

function hex(value) {
  const m = String(value).trim().match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `expected a six digit hex colour, got ${value}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}

function luminance([r, g, b]) {
  const channel = (v) => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

function block(pattern, label) {
  const match = css.match(pattern);
  assert.ok(match, `expected ${label}`);
  return match[1];
}

function token(scope, name) {
  const match = scope.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `--${name} is defined`);
  return match[1];
}

const light = block(/:root \{([\s\S]*?)\n\}/, 'the light token block');
const dark = block(/\[data-theme="dark"\] \{([\s\S]*?)\n\}/, 'the dark token block');

test('both themes define the same core roles', () => {
  for (const name of ['bg', 'surface', 'ink', 'muted', 'accent', 'accent-ink', 'panel', 'panel-ink', 'focus']) {
    assert.ok(token(light, name), `light --${name}`);
    assert.ok(token(dark, name), `dark --${name}`);
  }
});

test('running text keeps 4.5:1 in both themes', () => {
  for (const [name, scope] of [['light', light], ['dark', dark]]) {
    for (const role of ['ink', 'muted']) {
      const ratio = contrast(hex(token(scope, role)), hex(token(scope, 'bg')));
      assert.ok(ratio >= 4.5, `${name} ${role}-on-background is ${ratio.toFixed(2)}`);
    }
  }
});

test('accent buttons keep 4.5:1 in both themes', () => {
  for (const [name, scope] of [['light', light], ['dark', dark]]) {
    const ratio = contrast(hex(token(scope, 'accent')), hex(token(scope, 'accent-ink')));
    assert.ok(ratio >= 4.5, `${name} accent contrast is ${ratio.toFixed(2)}`);
  }
});

test('the dark app panel and its focus ring stay legible', () => {
  const panel = token(light, 'panel');
  const panelInk = token(light, 'panel-ink');
  assert.ok(contrast(hex(panel), hex(panelInk)) >= 4.5, 'panel ink contrast');
  const focus = css.match(/\.app-window :focus-visible \{[^}]*outline-color:\s*(#[0-9a-f]{6})/i);
  assert.ok(focus, 'the app fragment focus colour is explicit');
  const ratio = contrast(hex(focus[1]), hex(panel));
  assert.ok(ratio >= 3, `focus ring contrast is ${ratio.toFixed(2)}`);
});

test('the page follows the OS when no theme is stored', () => {
  assert.match(css, /@media \(prefers-color-scheme: dark\)[\s\S]*:root:not\(\[data-theme\]\)/);
});

test('running body text is at least 16px', () => {
  const body = css.match(/body \{[^}]*font:\s*400\s+([\d.]+)px/i);
  assert.ok(body, 'body font size is explicit');
  assert.ok(Number(body[1]) >= 16, `body is ${body[1]}px`);
});

test('focus is visible and reduced motion is honoured', () => {
  assert.match(css, /:focus-visible \{[^}]*outline:\s*2px solid var\(--focus\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration:\s*\.01ms/);
});
