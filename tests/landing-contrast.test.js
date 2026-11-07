'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'website', 'styles.css'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'website', 'theme.js'), 'utf8');
const script = fs.readFileSync(path.join(root, 'website', 'script.js'), 'utf8');

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

test('light and dark themes both define the same core roles', () => {
  for (const name of ['bg', 'surface', 'ink', 'muted', 'accent', 'accent-ink', 'field-slate', 'field-sage', 'field-blush', 'field-olive']) {
    assert.ok(token(light, name), `light --${name}`);
    assert.ok(token(dark, name), `dark --${name}`);
  }
});

test('muted text keeps 4.5:1 in both themes', () => {
  for (const [name, scope] of [['light', light], ['dark', dark]]) {
    const ratio = contrast(hex(token(scope, 'muted')), hex(token(scope, 'bg')));
    assert.ok(ratio >= 4.5, `${name} muted-on-background contrast is ${ratio.toFixed(2)}`);
  }
});

test('accent buttons keep 4.5:1 in both themes', () => {
  for (const [name, scope] of [['light', light], ['dark', dark]]) {
    const ratio = contrast(hex(token(scope, 'accent')), hex(token(scope, 'accent-ink')));
    assert.ok(ratio >= 4.5, `${name} accent contrast is ${ratio.toFixed(2)}`);
  }
});

test('the olive field keeps its pale ink in both themes', () => {
  for (const [name, scope] of [['light', light], ['dark', dark]]) {
    const ratio = contrast(hex(token(scope, 'field-olive')), hex(token(scope, 'olive-ink')));
    assert.ok(ratio >= 4.5, `${name} olive field contrast is ${ratio.toFixed(2)}`);
  }
});

test('the release ribbon keeps 4.5:1 and wraps instead of clipping', () => {
  const rule = css.match(/\.release-ribbon \{([\s\S]*?)\n\}/);
  assert.ok(rule, 'the ribbon rule exists');
  assert.match(rule[1], /background:\s*var\(--accent\)/);
  assert.match(rule[1], /color:\s*var\(--accent-ink\)/);
  assert.match(rule[1], /flex-wrap:\s*wrap/);
  assert.doesNotMatch(rule[1], /white-space:\s*nowrap/);
});

test('the page follows the operating system until a choice is stored', () => {
  assert.match(theme, /prefers-color-scheme: dark/);
  assert.match(script, /prefers-color-scheme: dark/);
  assert.match(script, /systemTheme\.addEventListener\('change'/);
  assert.match(script, /saved !== 'light' && saved !== 'dark'/);
});

test('the hero note and body text stay above the floor', () => {
  const rule = css.match(/\.hero-note \{[^}]*font-size:\s*([.\d]+)rem/);
  assert.ok(rule, 'the hero note size is explicit');
  assert.ok(parseFloat(rule[1]) * 16 >= 11, 'hero note is at least 11px');
  const body = css.match(/--step-body:\s*clamp\(([\d.]+)rem/);
  assert.ok(body && parseFloat(body[1]) >= 1.0625, 'body step starts at 17px');
});
