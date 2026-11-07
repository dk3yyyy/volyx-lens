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
  assert.match(root, /--accent:\s*#6677FF/);
  assert.match(root, /--accent-fill:\s*#505BDF/);
  assert.match(root, /--accent-fill-hi:\s*#5A66E8/);
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
