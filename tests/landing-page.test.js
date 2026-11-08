'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const website = path.join(root, 'website');
const read = (file) => fs.readFileSync(path.join(website, file), 'utf8');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const html = read('index.html');
const css = read('styles.css');
const script = read('script.js');
const theme = read('theme.js');
const version = require('../package.json').version;
const v = escapeRegExp(version);

test('landing page ships a semantic, truthful static entry point', () => {
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.equal((html.match(/<h1\b/gi) || []).length, 1);
  assert.match(html, /Choose what your AI sees and hears/i);
  assert.match(html, /Volyx Lens is a desktop AI panel/i);
  assert.match(html, /There is no relay and no analytics SDK/i);
  assert.match(html, /best-effort/i);
  assert.match(html, /Apache License 2\.0/i);
  assert.match(html, /macOS, Windows and Linux builds are unsigned\. Every file includes a SHA-256 checksum and a CycloneDX SBOM/i);
  assert.doesNotMatch(html, /VolyxAI/i);
  assert.doesNotMatch(html, /customer(s)?|trusted by|SOC\s?2|guaranteed invisible/i);
});

test('landing page offers per-platform downloads with direct release assets', () => {
  assert.equal((html.match(/class="platform"/g) || []).length, 6);
  assert.equal((html.match(/data-download/g) || []).length, 2);
  assert.match(html, new RegExp(`volyx-lens-${v}-win-x64\\.exe`));
  assert.match(html, new RegExp(`volyx-lens-${v}-mac-arm64-unsigned\\.dmg`));
  assert.match(html, new RegExp(`volyx-lens-${v}-mac-x64-unsigned\\.dmg`));
  assert.match(html, new RegExp(`volyx-lens-${v}-linux-x86_64\\.AppImage`));
  assert.match(html, new RegExp(`volyx-lens-${v}-linux-arm64\\.AppImage`));
  assert.match(html, new RegExp(`releases/tag/v${v}`));
});

test('landing page presents the response providers the app actually supports', () => {
  for (const provider of ['OpenAI', 'Anthropic', 'Google Gemini', 'Azure Foundry', 'DeepSeek', 'Groq', 'OpenRouter', 'NVIDIA', 'Ollama', 'Opencode', 'Opencode Go', 'Custom (OpenAI-compatible)']) {
    assert.match(html, new RegExp(`>${escapeRegExp(provider)}<`), `${provider} missing`);
  }
  assert.match(html, /12 response providers/i);
  assert.match(html, /Groq Whisper/i);
  assert.match(html, /Local Whisper/i);
  assert.doesNotMatch(html, /Azure OpenAI/i);
});

test('landing page attributes the product to its actual owner', () => {
  assert.match(html, /©\s*<span[^>]*data-year[^>]*>\d{4}<\/span>\s*Joshua Nwachinemere/i);
  assert.doesNotMatch(html, /VolyxAI/i);
});

test('landing page preserves the canonical Volyx Lens logo byte for byte', () => {
  assert.equal(
    sha256(path.join(website, 'assets', 'volyx-lens-logo.svg')),
    sha256(path.join(root, 'renderer', 'assets', 'volyx-lens-logo.svg')),
  );
});

test('the one-line install is in the hero and has a working fallback', () => {
  assert.match(html, /data-install-command/);
  assert.match(html, /data-copy-command/);
  assert.match(html, /data-install-platform="windows"/);
  assert.match(script, /INSTALL_COMMANDS/);
  assert.match(css, /\.app-preview\s*\{/);
  assert.doesNotMatch(html, /data-source/);
});

test('landing page ships accessible navigation, preview semantics and reduced motion', () => {
  assert.match(html, /<button[^>]+aria-controls="site-nav"[^>]+aria-expanded="false"/i);
  assert.match(html, /class="ap-chip"><b>Screen<\/b>/);
  assert.match(html, /class="ap-chip"><b>Mic<\/b>/);
  assert.match(html, /class="ap-chip is-off"><b>System<\/b>/);
  assert.doesNotMatch(html, /data-source/);
  assert.match(html, /<noscript>/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
  assert.match(css, /min-height:\s*44px/);
  assert.doesNotMatch(script, /innerHTML\s*=/i);
  const toggle = html.match(/<button[^>]*data-theme-toggle[^>]*>/)[0];
  assert.doesNotMatch(toggle, /aria-pressed/, 'the theme toggle names the action, not a pressed state');
});

test('landing page explains the implemented context, meeting, coding and offline boundaries', () => {
  assert.match(html, /Task Context/i);
  assert.match(html, /Keep several views in Task Context/i);
  assert.doesNotMatch(html, /Mail|Calendar/);
  assert.match(html, /Reference tab/i);
  assert.match(html, /Old revision/i);
  assert.match(html, /tells you what it left out/i);
  assert.match(html, /You and Them/i);
  assert.match(html, /meeting transcripts/i);
  assert.match(html, /notes only when you ask/i);
  assert.match(html, /offline/i);
  assert.match(html, /Keys are stored on your machine/i);
  assert.match(html, /keys stay in memory for the session/i);
  assert.match(html, /Recording law is still your responsibility/i);
  assert.match(html, /off by default/i);
});

test('landing page publishes complete canonical and social metadata with a strict CSP', () => {
  const canonical = 'https://volyxlens.pages.dev/';
  assert.ok(html.includes(`<link rel="canonical" href="${canonical}"`));
  assert.ok(html.includes(`<meta property="og:url" content="${canonical}"`));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
  const image = html.match(/<meta property="og:image" content="([^"]+)"/);
  assert.ok(image && image[1].startsWith(canonical));
  assert.equal(html.match(/<meta name="twitter:image" content="([^"]+)"/)[1], image[1]);
  assert.match(html, /<meta property="og:image:width" content="1200">/);
  assert.match(html, /<meta property="og:image:height" content="630">/);
  assert.match(html, /<meta name="twitter:image:alt" content="[^"]+">/);

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
  assert.deepEqual(directives['script-src'], ["'self'", "'sha256-vdu1mkBtPj4jSI7Qn/t3Za7dntLpf7U6DAMMy5QREGw='"]);
  assert.deepEqual(directives['connect-src'], ["'none'"]);
  assert.doesNotMatch(match[1], /(?:\*|https?:|unsafe-inline|unsafe-eval)/i);
  assert.match(html, /"license":\s*"https:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0"/);
});

test('landing page links to existing license, security and issue documents', () => {
  assert.match(html, /blob\/main\/LICENSE\.md/i);
  assert.match(html, /github\.com\/dk3yyyy\/volyx-lens\/security\/policy/i);
  assert.match(html, /github\.com\/dk3yyyy\/volyx-lens\/issues\/new/i);
  assert.match(html, /Report an issue/i);
  assert.doesNotMatch(html, /blob\/main\/SECURITY\.md/i);
  assert.ok(fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8').endsWith('\n'));
});

test('landing page renders the interface as a designed scene, not a screenshot', () => {
  assert.match(html, /class="app-preview"[^>]*role="img"/);
  assert.match(html, /aria-label="Volyx Lens desktop app/);
  assert.doesNotMatch(html, /class="context-panel"/);
  assert.doesNotMatch(html, /Capture sources/i);
  assert.match(html, /work-scene/);
  assert.doesNotMatch(html, /volyx-lens-stage\.png/);
});

test('download OS detection maps desktop platforms, architecture and ignores mobile', async () => {
  const start = script.indexOf('async function macArch()');
  const end = script.indexOf('initDownloads();');
  assert.ok(start > 0 && end > start, 'detection functions present');
  const source = script.slice(start, end);
  const makeDetect = new Function('navigator', `${source}; return detectOS;`);

  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'win'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', 'mac'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'linux-x64'],
    ['Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'linux-arm64'],
    ['Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36', null],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', null],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', null],
  ];
  for (const [ua, expected] of cases) {
    const detect = makeDetect({ userAgent: ua, maxTouchPoints: 0 });
    assert.equal(await detect(), expected, `UA: ${ua}`);
  }

  const macUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
  const arm = makeDetect({ userAgent: macUa, maxTouchPoints: 0, userAgentData: { getHighEntropyValues: async () => ({ architecture: 'arm' }) } });
  const intel = makeDetect({ userAgent: macUa, maxTouchPoints: 0, userAgentData: { getHighEntropyValues: async () => ({ architecture: 'x86' }) } });
  assert.equal(await arm(), 'mac-arm64');
  assert.equal(await intel(), 'mac-x64');
});

test('theme follows the OS until a choice is stored, with a no-JS fallback', () => {
  assert.match(theme, /prefers-color-scheme: dark/);
  assert.match(script, /prefers-color-scheme: dark/);
  assert.match(script, /systemTheme\.addEventListener\('change'/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)[\s\S]*:root:not\(\[data-theme\]\)/);
  assert.match(script, /Switch to dark mode \(currently light\)/);
});

test('site ships legal, 404, discovery and icon surfaces with per-page metadata', () => {
  const privacy = read('privacy.html');
  const notFound = read('404.html');
  for (const page of [privacy, notFound]) {
    assert.match(page, /<title>[^<]+<\/title>/);
    assert.match(page, /<meta name="description" content="[^"]+">/);
    assert.match(page, /<link rel="icon" href="assets\/favicon.ico"/);
    assert.match(page, /<link rel="apple-touch-icon" href="assets\/apple-touch-icon.png">/);
  }
  assert.match(privacy, /<link rel="canonical" href="https:\/\/volyxlens\.pages\.dev\/privacy">/);
  assert.match(privacy, /property="og:image" content="https:\/\/volyxlens\.pages\.dev\/assets\/volyx-lens-social-1200x630-v2\.png"/);
  assert.match(notFound, /<meta name="robots" content="noindex,follow">/);
  assert.match(read('robots.txt'), /Sitemap: https:\/\/volyxlens\.pages\.dev\/sitemap\.xml/);
  assert.match(read('sitemap.xml'), /https:\/\/volyxlens\.pages\.dev\/privacy/);
  assert.match(read('site.webmanifest'), /"icons"/);
  for (const file of ['favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'volyx-lens-social-1200x630-v2.png']) {
    assert.ok(fs.statSync(path.join(website, 'assets', file)).size > 0, `${file} is empty`);
  }
  const images = [...html.matchAll(/<img\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(images.length > 0);
  for (const tag of images) assert.match(tag, /\balt="/, `image has no alt attribute: ${tag}`);
  assert.ok(html.includes('href="/privacy"'));
});
