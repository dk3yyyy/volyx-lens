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
  assert.match(html, /Production release[\s\S]*?v0\.4\.0/i);
  assert.match(html, /best-effort/i);
  assert.match(html, /there is no Volyx Lens-operated intermediary server/i);
  assert.match(html, /Apache License 2\.0/i);
  assert.doesNotMatch(html, /customer(s)?|trusted by|SOC\s?2|guaranteed invisible/i);
});

test('landing page presents the response providers the app actually supports', () => {
  const html = read('index.html');
  const expectedProviders = ['OpenAI', 'Anthropic', 'Google Gemini', 'Azure Foundry', 'DeepSeek', 'Groq', 'OpenRouter', 'Ollama', 'Deepgram', 'Azure AI Speech'];

  for (const provider of expectedProviders) {
    assert.match(html, new RegExp(`>${provider.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}<`, 'i'));
  }
  assert.match(html, /Ten routes/i);
  assert.doesNotMatch(html, /Azure OpenAI/i);
});

test('landing page describes both architectures published by the current test release', () => {
  const html = read('index.html');

  assert.match(html, /Apple Silicon and Intel/i);
  assert.doesNotMatch(html, /for Apple Silicon\./i);
});

test('landing page attributes the independent product to its actual owner', () => {
  const html = read('index.html');

  assert.match(html, /©\s*<span[^>]*data-year[^>]*>\d{4}<\/span>\s*Joshua Nwachinemere/i);
  assert.doesNotMatch(html, /VolyxAI/i);
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

test('landing page explains the implemented context, meeting, coding, and offline boundaries', () => {
  const html = read('index.html');

  assert.match(html, /Task Context/i);
  assert.match(html, /multiple (?:selected )?screens/i);
  assert.match(html, /bounded visual window/i);
  assert.match(html, /discloses omitted screens/i);
  assert.match(html, /memory-bounded/i);
  assert.match(html, /memory-only/i);
  assert.match(html, /cleared when the session ends/i);
  assert.match(html, /You\/Them/i);
  assert.match(html, /reply suggestions/i);
  assert.match(html, /meeting recaps/i);
  assert.match(html, /coding/i);
  assert.match(html, /AI responses require a configured provider/i);
  assert.match(html, /run fully offline/i);
  assert.match(html, /Local Whisper/i);
  assert.match(html, /cloud fallback remains off by default/i);
  assert.match(html, /plaintext credential record/i);
  assert.match(html, /Contact \/ licensing/i);
});

test('landing page publishes complete canonical and social metadata with a strict CSP', () => {
  const html = read('index.html');
  const canonicalUrl = 'https://volyxlens.pages.dev/';
  const socialImage = `${canonicalUrl}assets/volyx-lens-onboarding.png`;

  assert.ok(html.includes(`<link rel="canonical" href="${canonicalUrl}"`));
  assert.ok(html.includes(`<meta property="og:url" content="${canonicalUrl}"`));
  assert.ok(html.includes(`<meta property="og:image" content="${socialImage}"`));
  assert.ok(html.includes(`<meta name="twitter:image" content="${socialImage}"`));

  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(match, 'expected a Content-Security-Policy meta tag');
  const directives = Object.fromEntries(match[1].split(';').map((entry) => {
    const [name, ...sources] = entry.trim().split(/\s+/);
    return [name, sources];
  }));

  assert.deepEqual(Object.keys(directives).sort(), [
    'base-uri', 'connect-src', 'default-src', 'font-src', 'form-action',
    'img-src', 'object-src', 'script-src', 'style-src',
  ]);
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.deepEqual(directives['script-src'], ["'self'", "'sha256-vdu1mkBtPj4jSI7Qn/t3Za7dntLpf7U6DAMMy5QREGw='"]);
  assert.deepEqual(directives['style-src'], ["'self'"]);
  assert.deepEqual(directives['img-src'], ["'self'"]);
  assert.deepEqual(directives['font-src'], ["'self'"]);
  assert.deepEqual(directives['connect-src'], ["'none'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
  assert.doesNotMatch(match[1], /(?:\*|https?:|unsafe-inline|unsafe-eval)/i);
  assert.match(html, /"license":\s*"https:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0"/);
  assert.doesNotMatch(html, /polyformproject\.org/i);
});

test('landing page links to existing license and security documents', () => {
  const html = read('index.html');
  const securityPolicy = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');

  assert.doesNotMatch(html, /blob\/main\/LICENSE(?:["#?])/);
  assert.match(html, /blob\/main\/LICENSE\.md/i);
  assert.match(html, /github\.com\/dk3yyyy\/volyx-lens\/security\/policy/i);
  assert.doesNotMatch(html, /blob\/main\/SECURITY\.md/i);
  assert.match(securityPolicy, /security\/advisories\/new/i);
  assert.doesNotMatch(securityPolicy, /issues\/new/i);
  assert.ok(securityPolicy.endsWith('\n'));
});

test('reduced motion avoids an unfocusable scroll region and callouts meet contrast styling', () => {
  const css = read('styles.css');

  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.marquee\s*\{[^}]*overflow:\s*hidden/i);
  assert.match(css, /\.window-callout span\s*\{[^}]*color:\s*#5c3fe3/i);
  assert.match(css, /\.brand[^\{]*\{[^}]*min-height:\s*44px/i);
  assert.match(css, /\.footer-links a\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/i);
  assert.match(css, /\.responsibility-copy a\s*\{[^}]*min-height:\s*44px/i);
});
