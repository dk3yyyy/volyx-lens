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

function lightToken(name) {
  const block = css.match(/html\[data-theme='light'\] \{([\s\S]*?)\}/);
  assert.ok(block, 'the light theme block exists');
  const token = block[1].match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(token, `light --${name} is defined`);
  return token[1];
}

test('secondary text keeps 4.5:1 on the light paper', () => {
  const ratio = contrast(hex(lightToken('dim')), hex(lightToken('night')));
  assert.ok(ratio >= 4.5, `light --dim contrast is ${ratio.toFixed(2)}`);
});

test('the cyan section label is darkened for the light paper', () => {
  const rule = css.match(/html\[data-theme='light'\] \.eyebrow \{ color: (#[0-9a-f]{6}); \}/i);
  assert.ok(rule, 'the light eyebrow override exists');
  const ratio = contrast(hex(rule[1]), hex(lightToken('night')));
  assert.ok(ratio >= 4.5, `eyebrow contrast is ${ratio.toFixed(2)}`);
});

test('the changelog is readable on the indigo release section', () => {
  const list = css.match(/\.whats-new ul \{[\s\S]*?color: (#[0-9a-f]{6});/i);
  assert.ok(list, 'the changelog colour is explicit');
  const section = css.match(/\.release-section \{[^}]*background:\s*(#[0-9a-f]{6})/i);
  assert.ok(section, 'the release section background is explicit');
  const ratio = contrast(hex(list[1]), hex(section[1]));
  assert.ok(ratio >= 4.5, `changelog contrast is ${ratio.toFixed(2)}`);
  assert.match(css, /\.whats-new li \{[^}]*text-align: left/);
});

test('the release section eyebrow stays ink on the indigo band', () => {
  const rule = css.match(/html\[data-theme='light'\] \.release-section \.eyebrow \{ color: (#[0-9a-f]{6}); \}/i);
  assert.ok(rule, 'the release eyebrow override exists');
  const section = css.match(/\.release-section \{[^}]*background:\s*(#[0-9a-f]{6})/i);
  const ratio = contrast(hex(rule[1]), hex(section[1]));
  assert.ok(ratio >= 4.5, `release eyebrow contrast is ${ratio.toFixed(2)}`);
});

test('the release ribbon keeps 4.5:1 in the light theme', () => {
  const ribbon = css.match(/html\[data-theme='light'\] \.release-ribbon \{\s*background: (#[0-9a-f]{6});\s*color: (#[0-9a-f]{6});/i);
  assert.ok(ribbon, 'the light ribbon colours are explicit');
  const ratio = contrast(hex(ribbon[1]), hex(ribbon[2]));
  assert.ok(ratio >= 4.5, `ribbon contrast is ${ratio.toFixed(2)}`);
});

test('the ribbon wraps on a phone instead of clipping', () => {
  const block = css.match(/@media \(max-width: 560px\) \{([\s\S]*?)\n\}/);
  assert.ok(block, 'the phone ribbon rule exists');
  assert.match(block[1], /\.release-ribbon \{[\s\S]*?flex-wrap: wrap/);
  assert.match(block[1], /white-space: normal/);
  assert.match(block[1], /\.release-divider \{ display: none; \}/);
});

test('the hero trust line is at least 11px', () => {
  const rule = css.match(/\.hero-note \{[^}]*font-size: ([.\d]+)rem/);
  assert.ok(rule, 'the hero note size is explicit');
  const px = parseFloat(rule[1]) * 16;
  assert.ok(px >= 11, `hero note is ${px}px`);
});
