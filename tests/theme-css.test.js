const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const rootStart = css.indexOf(':root {');
const rootEnd = css.indexOf('\n}', rootStart);
const root = css.slice(rootStart, rootEnd);

function rule(selector) {
  const start = css.indexOf(`\n${selector} {`) + 1;
  assert.ok(start > 0, `${selector} exists`);
  return css.slice(start, css.indexOf('}', start));
}

test('the root declares the accent foreground and fill roles separately', () => {
  for (const token of [
    '--accent', '--accent-hi', '--accent-soft', '--accent-fill', '--accent-fill-hi',
    '--accent-ink', '--accent-hair', '--accent-wash', '--accent-glow',
  ]) {
    assert.match(root, new RegExp(`${token}:`), `${token} is declared`);
  }
  assert.match(root, /--accent:\s*#B3CEB7/);
  assert.match(root, /--accent-fill:\s*#567250/);
  assert.match(root, /--accent-fill-hi:\s*#5C7A56/);
  assert.match(root, /--accent-ink:\s*#FFFFFF/);
});

test('filled controls use the fill and ink roles, not the foreground accent', () => {
  const bubble = rule('.user-bubble');
  assert.match(bubble, /background:\s*var\(--accent-fill\)/);
  assert.match(bubble, /color:\s*var\(--accent-ink\)/);
  assert.doesNotMatch(bubble, /background:\s*var\(--accent\)/);

  const send = rule('#send-btn');
  assert.match(send, /background:\s*var\(--accent-fill\)/);
  assert.match(send, /color:\s*var\(--accent-ink\)/);

  const close = rule('.s-close');
  assert.match(close, /var\(--accent-fill-hi\),\s*var\(--accent-fill\)/);
  assert.match(close, /color:\s*var\(--accent-ink\)/);
});

test('the foreground accent still carries non-filled emphasis', () => {
  assert.match(rule('.ai-caret'), /background:\s*var\(--accent\)/);
});

test('the existing focus ring stays on the accent-soft role', () => {
  const focus = rule('button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible');
  assert.match(focus, /outline:\s*2px solid var\(--accent-soft\)/);
});


function withoutBlock(source, selector) {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) return source;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(0, start) + source.slice(i + 1);
    }
  }
  return source;
}

test('accent literals live only in the indigo declaration blocks', () => {
  let remaining = css;
  for (const selector of [':root', ':root[data-accent-theme="indigo"]', 'body.window-inactive', ':root[data-accent-theme="indigo"] body.window-inactive']) remaining = withoutBlock(remaining, selector);
  const forbidden = [
    /rgba\(\s*102\s*,\s*119\s*,\s*255/i,
    /rgba\(\s*125\s*,\s*138\s*,\s*255/i,
    /#C7CEFF/i, /#D9DCFF/i, /#AAB5FF/i, /#B5BEFF/i, /#a9c8ff/i, /#a072ff/i, /#6677FF/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(remaining, pattern);
});
