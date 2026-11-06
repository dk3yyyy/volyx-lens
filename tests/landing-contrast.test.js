'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'website', 'styles.css'), 'utf8');

function hex(value) {
  const m = value.trim().match(/^#([0-9a-f]{6})$/i);
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

function token(blockPattern, name) {
  const block = css.match(blockPattern);
  assert.ok(block, `expected a theme block matching ${blockPattern}`);
  const value = block[1].match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(value, `--${name} is defined`);
  return value[1];
}

function rootToken(name) {
  return token(/:root \{([\s\S]*?)\n\}/, name);
}

function releaseToken(name) {
  return token(/\.release-section \{([\s\S]*?)\n\}/, name);
}

test('muted text keeps 4.5:1 on the page ground', () => {
  const ratio = contrast(hex(rootToken('muted')), hex(rootToken('bg')));
  assert.ok(ratio >= 4.5, `muted-on-background contrast is ${ratio.toFixed(2)}`);
});

test('hero note keeps 4.5:1 on the dark hero', () => {
  const ratio = contrast(hex(rootToken('deep-muted')), hex(rootToken('deep')));
  assert.ok(ratio >= 4.5, `hero note contrast is ${ratio.toFixed(2)}`);
});

test('the release section keeps its own dark ink on the mint field', () => {
  const ink = hex(releaseToken('ink'));
  const muted = hex(releaseToken('muted'));
  const background = hex(rootToken('accent'));
  assert.ok(contrast(ink, background) >= 4.5, 'release ink contrast');
  assert.ok(contrast(muted, background) >= 4.5, 'release muted contrast');
});

test('the release section does not inherit the dark-theme ink', () => {
  assert.match(css, /\.release-section \{[\s\S]*?--ink: #232323/i);
});

test('the aperture fragment keeps 4.5:1 on its light panel', () => {
  const ratio = contrast(hex('#5f5f5f'), hex('#f3f3f3'));
  assert.ok(ratio >= 4.5, `aperture note contrast is ${ratio.toFixed(2)}`);
});

test('the release ribbon keeps 4.5:1 and wraps instead of clipping', () => {
  const rule = css.match(/\.release-ribbon \{([\s\S]*?)\n\}/);
  assert.ok(rule, 'the ribbon rule exists');
  assert.match(rule[1], /background:\s*var\(--deep\)/);
  assert.match(rule[1], /color:\s*var\(--deep-muted\)/);
  const ratio = contrast(hex(rootToken('deep')), hex(rootToken('deep-muted')));
  assert.ok(ratio >= 4.5, `ribbon contrast is ${ratio.toFixed(2)}`);
  assert.match(rule[1], /flex-wrap:\s*wrap/, 'the ribbon wraps at narrow widths');
  assert.doesNotMatch(rule[1], /white-space:\s*nowrap/, 'the ribbon never clips');
});

test('the hero note does not fall below 11px', () => {
  const rule = css.match(/\.hero-note \{[^}]*font-size:\s*([.\d]+)rem/);
  assert.ok(rule, 'the hero note size is explicit');
  assert.ok(parseFloat(rule[1]) * 16 >= 11, 'hero note is at least 11px');
});
