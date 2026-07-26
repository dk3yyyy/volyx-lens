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
const architecture = fs.readFileSync(path.join(website, 'assets', 'architecture.svg'), 'utf8');

const occurrences = (text, pattern) => [...text.matchAll(pattern)].length;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cssBlock = (source, header) => {
  const headerIndex = source.indexOf(header);
  assert.notEqual(headerIndex, -1, `missing CSS block: ${header}`);
  const openIndex = source.indexOf('{', headerIndex + header.length);
  assert.notEqual(openIndex, -1, `missing opening brace for: ${header}`);

  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }
  assert.fail(`missing closing brace for: ${header}`);
};

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

  const forbidden = ['guaranteed invisible', 'completely private', 'SOC 2', 'trusted by', 'customers worldwide'];
  for (const claim of forbidden) assert.ok(!html.toLowerCase().includes(claim.toLowerCase()), `forbidden claim: ${claim}`);

  const affiliationSurface = `${html}\n${css}\n${js}\n${architecture}`
    .replace(/https?:[^\s"'<>]+/gi, '')
    .replace(/mailto:[^\s"'<>]+/gi, '');
  assert.doesNotMatch(affiliationSurface, /VolyxAI/i);
});

test('canonical eye asset is copied without modification', () => {
  const source = path.join(root, 'renderer', 'assets', 'volyx-lens-logo.svg');
  const websiteCopy = path.join(website, 'assets', 'volyx-lens-logo.svg');
  assert.equal(hash(websiteCopy), hash(source));
});

test('onboarding image keeps its native dimensions and is never upscaled', () => {
  assert.match(html, /onboarding-welcome-eye\.png" width="700" height="573"/);
  assert.match(css, /\.product-frame \{ width: min\(100%, 736px\);/);
  assert.match(css, /\.product-frame img \{ display: block; width: 100%; max-width: 700px; height: auto;/);
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
  const mobileCss = cssBlock(css, '@media (max-width: 700px)');

  assert.match(css, /@media \(max-width: 980px\)/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /@media \(max-width: 380px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(mobileCss, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(mobileCss, /\.source-tabs\s*\{[\s\S]*?gap: 4px;[\s\S]*?padding: 6px;[\s\S]*?overflow: visible;/);
  assert.match(mobileCss, /\.source-tabs button\s*\{[\s\S]*?min-width: 0;[\s\S]*?min-height: 48px;/);
  assert.match(mobileCss, /\.source-number,[\s\S]*?\.source-tabs button > span:last-child\s*\{ display: none; \}/);
  assert.match(mobileCss, /\.source-tabs button\[aria-selected="true"\]\s*\{[\s\S]*?background: rgba\(141, 124, 255, \.14\);[\s\S]*?border-color: rgba\(141, 124, 255, \.28\);/);
  assert.match(mobileCss, /\.source-tabs button\[aria-selected="true"\]::after\s*\{ display: none; \}/);
  assert.doesNotMatch(mobileCss, /min-width:\s*(?:185|200)px/);
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
