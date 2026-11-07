const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start !== -1, `${selector} exists`);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`${selector} is not closed`);
}

function vars(source) {
  return new Map([...source.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function rgb(hex) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hue(hex) {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const themes = {
  indigo: block(':root[data-accent-theme="indigo"]'),
  sage: block(':root'),
  ember: block(':root[data-accent-theme="ember"]'),
};

const required = [
  'accent', 'accent-hi', 'accent-soft', 'accent-fill', 'accent-fill-hi', 'accent-ink',
  'accent-hair', 'accent-wash', 'accent-glow', 'accent-muted', 'accent-muted-fill',
  'accent-muted-hi', 'accent-muted-soft',
];

test('all three themes declare the full accent family', () => {
  for (const [name, source] of Object.entries(themes)) {
    const tokens = vars(source);
    for (const token of required) assert.ok(tokens.has(token), `${name} declares --${token}`);
  }
});

test('filled controls keep white text above 4.5:1 in every theme', () => {
  for (const [name, source] of Object.entries(themes)) {
    const tokens = vars(source);
    for (const fill of ['accent-fill', 'accent-fill-hi', 'accent-muted-fill']) {
      assert.ok(contrast('#FFFFFF', tokens.get(fill)) >= 4.5, `${name} white on --${fill}`);
    }
  }
});

test('foreground and focus accents read on both shared surfaces', () => {
  for (const [name, source] of Object.entries(themes)) {
    const tokens = vars(source);
    for (const surface of ['#0B1020', '#131A2B']) {
      for (const token of ['accent', 'accent-hi', 'accent-soft', 'accent-muted', 'accent-muted-soft']) {
        assert.ok(contrast(tokens.get(token), surface) >= 4.5, `${name} --${token} on ${surface}`);
      }
      assert.ok(contrast(tokens.get('accent-muted'), surface) >= 3, `${name} --accent-muted on ${surface}`);
    }
  }
});

test('each accent is visually distinct from the live cyan', () => {
  for (const [name, source] of Object.entries(themes)) {
    const accent = vars(source).get('accent');
    assert.ok(hueDistance(hue(accent), hue('#42CFE8')) >= 30, `${name} accent hue is ${hue(accent)}`);
  }
});

test('status colours are shared, not redeclared by a theme', () => {
  for (const selector of [':root[data-accent-theme="sage"]', ':root[data-accent-theme="ember"]']) {
    const source = block(selector);
    for (const token of ['cyan', 'live', 'warning', 'danger', 'tx-1', 'tx-2', 'tx-mut']) {
      assert.doesNotMatch(source, new RegExp(`--${token}\\s*:`), `${selector} must not declare --${token}`);
    }
  }
});

test('the warning chip does not collide with Ember soft', () => {
  const chip = block('#task-context-eviction');
  assert.match(chip, /color:\s*var\(--warning\)/);
  assert.doesNotMatch(chip, /#FFD49A/i);
});

test('the settings input boundary is visible on every palette', () => {
  const field = block('.s-field input, .s-field select');
  assert.match(field, /border:\s*1px solid var\(--field-border\)/);
  assert.doesNotMatch(field, /rgba\(255,255,255,0\.14\)/);
  const focus = block('.s-field input:focus-visible, .s-field select:focus-visible');
  assert.match(focus, /outline:\s*2px solid var\(--accent-soft\)/);
  assert.match(focus, /outline-offset:\s*1px/);
});

test('each theme keeps its inactive palette in the same hue', () => {
  const inactive = {
    indigo: block(':root[data-accent-theme="indigo"] body.window-inactive'),
    sage: block(':root[data-accent-theme="sage"] body.window-inactive'),
    ember: block(':root[data-accent-theme="ember"] body.window-inactive'),
  };
  for (const [name, source] of Object.entries(inactive)) {
    const active = vars(themes[name]);
    const dimmed = vars(source);
    assert.equal(dimmed.get('accent'), active.get('accent-muted'), `${name} inactive foreground`);
    assert.equal(dimmed.get('accent-hi'), active.get('accent-muted-hi'), `${name} inactive hover`);
    assert.equal(dimmed.get('accent-soft'), active.get('accent-muted-soft'), `${name} inactive focus`);
    assert.equal(dimmed.get('accent-fill'), active.get('accent-muted-fill'), `${name} inactive fill`);
    assert.ok(contrast('#FFFFFF', dimmed.get('accent-fill')) >= 4.5, `${name} inactive filled text`);
    assert.ok(contrast(dimmed.get('accent'), '#0B1020') >= 4.5, `${name} inactive foreground on panel`);
  }
  for (const name of ['sage', 'ember']) {
    assert.doesNotMatch(inactive[name], /--(cyan|live|warning|danger):/, `${name} must not redeclare status`);
  }
});

test('the glass surfaces take the accent tint, not just the buttons', () => {
  const tinted = css.match(/box-shadow:[^;]*var\(--accent\)/g) || [];
  assert.ok(tinted.length >= 3, `expected at least three accent-tinted glass surfaces, found ${tinted.length}`);
  assert.match(css, /--bd-hair:\s*color-mix\(in srgb, var\(--accent-soft\)/);
  assert.match(css, /--fill-2:\s*color-mix\(in srgb, var\(--accent-soft\)/);
});
