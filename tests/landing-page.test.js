'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const website = path.join(root, 'website');

function read(relativePath) {
  return fs.readFileSync(path.join(website, relativePath), 'utf8');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('landing page ships a semantic, truthful static entry point', () => {
  const html = read('index.html');

  assert.match(html, /<main\b[^>]*id="main"/i);
  assert.equal((html.match(/<h1\b/gi) || []).length, 1);
  assert.match(html, /A private assistant for your Mac/i);
  assert.match(html, /ad-hoc signed test build/i);
  assert.match(html, /best-effort/i);
  assert.match(html, /there is no VolyxAI (?:server|cloud|intermediary)/i);
  assert.match(html, /PolyForm Noncommercial 1\.0\.0/i);
  assert.doesNotMatch(html, /customer(s)?|trusted by|SOC\s?2|guaranteed invisible/i);
});

test('landing page preserves the canonical Volyx Lens eye byte for byte', () => {
  const canonical = path.join(root, 'renderer', 'assets', 'volyx-lens-logo.svg');
  const websiteLogo = path.join(website, 'assets', 'volyx-lens-logo.svg');

  assert.equal(sha256(websiteLogo), sha256(canonical));
});

test('landing page includes accessible navigation, context controls, and reduced-motion support', () => {
  const html = read('index.html');
  const css = read('styles.css');
  const script = read('script.js');

  assert.match(html, /<button[^>]+aria-controls="site-nav"[^>]+aria-expanded="false"/i);
  assert.match(html, /data-context="screen"/i);
  assert.match(html, /data-context="you"/i);
  assert.match(html, /data-context="them"/i);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
  assert.match(css, /min-(?:height|width):\s*44px/i);
  assert.doesNotMatch(script, /innerHTML\s*=/i);
});
