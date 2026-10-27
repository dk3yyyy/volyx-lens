'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');

function relativeLuminance(hex) {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function inactivePalette() {
  const block = styles.match(/body\.window-inactive\s*\{([\s\S]*?)\}/);
  assert.ok(block, 'the inactive window state is styled');
  const palette = {};
  for (const line of block[1].split('\n')) {
    const match = line.match(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/);
    if (match) palette[match[1]] = match[2];
  }
  return palette;
}

test('the window announces when it loses focus, and clears it again', () => {
  assert.match(renderer, /function applyWindowFocusState\(focused\)/);
  assert.match(renderer, /document\.body\.classList\.toggle\('window-inactive', !focused\)/);
  assert.match(renderer, /window\.addEventListener\('focus', \(\) => applyWindowFocusState\(true\)\)/);
  assert.match(renderer, /window\.addEventListener\('blur', \(\) => applyWindowFocusState\(false\)\)/);
  assert.match(renderer, /applyWindowFocusState\(document\.hasFocus\(\)\)/, 'the first paint does not wait for a focus event');
});

test('the inactive state tones down colour without touching layout', () => {
  const block = styles.match(/body\.window-inactive\s*\{([\s\S]*?)\}/);
  assert.ok(block, 'the inactive window state is styled');
  assert.match(block[1], /--accent:/, 'the accent is what carries the emphasis, so it dims');
  for (const layout of ['padding', 'margin', 'width', 'height', 'display', 'position', 'font-size']) {
    assert.ok(!new RegExp(`(^|\\s)${layout}\\s*:`, 'm').test(block[1]), `the inactive state must not change ${layout}`);
  }
});

test('the dimmed text stays legible on the panel surface', () => {
  const palette = inactivePalette();
  // The toolbar pill sits on rgba(11,16,32,0.88) glass, which over a dark room
  // reads close to the surface colour. Checking against the darkest surface is
  // the conservative case: if it passes here it passes over the lighter one.
  const surface = styles.match(/--surface-0:\s*(#[0-9A-Fa-f]{6})/)[1];
  for (const token of ['tx-1', 'tx-2']) {
    assert.ok(palette[token], `${token} is part of the inactive palette`);
    const ratio = contrastRatio(palette[token], surface);
    assert.ok(ratio >= 7, `${token} keeps a AAA contrast ratio when inactive (got ${ratio.toFixed(2)}:1)`);
  }
});

test('the live accent stays distinguishable from the inactive one', () => {
  const palette = inactivePalette();
  const liveAccent = styles.match(/--accent:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.notEqual(palette.accent.toLowerCase(), liveAccent.toLowerCase(), 'inactive windows must not look like focused ones');
});
