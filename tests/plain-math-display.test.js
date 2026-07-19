const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePlainMath } = require('../renderer/plain-math');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('normalizes the raw LaTeX patterns seen in vector and complexity answers', () => {
  assert.equal(
    normalizePlainMath('How do \\( \\hat{i} \\) and \\( \\hat{j} \\) represent \\((3,-2)\\)?'),
    'How do i-hat and j-hat represent (3,-2)?',
  );
  assert.equal(
    normalizePlainMath('Time: \\(O(n)\\), Space: \\(O(n)\\), and \\frac{a}{b} \\leq 1.'),
    'Time: O(n), Space: O(n), and (a)/(b) ≤ 1.',
  );
});

test('math normalization is applied only to prose while fenced and inline code stay on the safe markdown path', () => {
  assert.match(html, /<script src="plain-math\.js"><\/script>[\s\S]*<script src="renderer\.js"><\/script>/);
  assert.match(renderer, /split\(\/\(`\[\^`\]\*`\)\/g\)/);
  assert.match(renderer, /if \(inCode\) \{ html \+= esc\(line\) \+ '\\n'; continue; \}/);
  assert.doesNotMatch(renderer, /innerHTML\s*\+=\s*t/);
});

test('model prompts explicitly avoid unsupported LaTeX while retaining safe markdown', () => {
  assert.match(main, /UI supports plain text and basic Markdown but not LaTeX/);
  assert.match(main, /never emit/);
  assert.match(main, /const system = `\$\{baseSystem\}\\n\\n\$\{UNTRUSTED_INPUT_RULE\}\\n\\n\$\{PLAIN_TEXT_OUTPUT_RULE\}`/);
});
