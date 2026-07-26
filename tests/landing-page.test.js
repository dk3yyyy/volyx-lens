const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const website = path.join(root, 'website');
const html = fs.readFileSync(path.join(website, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(website, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(website, 'site.js'), 'utf8');

const occurrences = (text, pattern) => [...text.matchAll(pattern)].length;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('landing page has core semantic structure and one h1', () => {
  assert.match(html, /<html lang="en">/);
  assert.equal(occurrences(html, /<h1\b/g), 1);
  for (const element of ['<header', '<nav', '<main', '<footer']) {
    assert.ok(html.includes(element), `missing ${element}`);
  }
  assert.match(html, /class="skip-link" href="#main"/);
});

test('landing page preserves required product and release truth', () => {
  const required = [
    'No intermediary relay',
    'Requests go from the app to the provider you configure',
    'ad-hoc signed test builds',
    'not notarized by Apple',
    'Capture exclusion is best-effort. Never guaranteed.',
    'Do not disable Gatekeeper globally.',
    'PolyForm Noncommercial 1.0.0',
    'Apple Silicon and Intel Macs',
    'Third-party providers receive the data needed'
  ];
  for (const claim of required) assert.ok(html.includes(claim), `missing claim: ${claim}`);

  const forbidden = ['A VolyxAI project', 'guaranteed invisible', 'completely private', 'SOC 2', 'trusted by', 'customers worldwide'];
  for (const claim of forbidden) assert.ok(!html.toLowerCase().includes(claim.toLowerCase()), `forbidden claim: ${claim}`);
});

test('canonical eye asset is copied without modification', () => {
  const source = path.join(root, 'renderer', 'assets', 'volyx-lens-logo.svg');
  const websiteCopy = path.join(website, 'assets', 'volyx-lens-logo.svg');
  assert.equal(hash(websiteCopy), hash(source));
});

test('onboarding image keeps its native dimensions and is never upscaled', () => {
  assert.match(html, /onboarding-welcome-eye\.png" width="700" height="573"/);
  assert.match(css, /\.product-frame \{ width: min\(100%, 736px\);/);
  assert.match(css, /\.product-frame img \{ display: block; width: 100%; height: auto;/);
});

test('all local page assets exist and external links use allowed protocols', () => {
  const localRefs = [...html.matchAll(/(?:src|href)="(?!https?:|mailto:|#)([^"]+)"/g)].map((match) => match[1]);
  for (const ref of localRefs) assert.ok(fs.existsSync(path.join(website, ref)), `missing local asset: ${ref}`);

  const externalRefs = [...html.matchAll(/(?:src|href)="([a-z]+:[^"]+)"/g)].map((match) => match[1]);
  for (const ref of externalRefs) assert.match(ref, /^(https:|mailto:)/, `unsafe protocol: ${ref}`);
});

test('interactive context selector follows tab semantics', () => {
  assert.equal(occurrences(html, /role="tab"/g), 3);
  assert.equal(occurrences(html, /role="tabpanel"/g), 3);
  assert.match(js, /ArrowRight/);
  assert.match(js, /ArrowLeft/);
  assert.match(js, /Home/);
  assert.match(js, /End/);
  assert.match(js, /aria-selected/);
});

test('tablet/mobile navigation and reduced-motion safeguards are present', () => {
  assert.match(css, /@media \(max-width: 980px\)/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /@media \(max-width: 380px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(js, /window\.innerWidth > 980/);
});

test('page uses a restrictive CSP with a valid JSON-LD hash and no trackers', () => {
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /object-src 'none'/);

  const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(jsonLd, 'missing JSON-LD block');
  const jsonLdHash = crypto.createHash('sha256').update(jsonLd[1]).digest('base64');
  assert.ok(html.includes(`'sha256-${jsonLdHash}'`), 'CSP JSON-LD hash is stale');

  assert.doesNotMatch(html, /google-analytics|googletagmanager|segment\.com|mixpanel|hotjar/i);
});
