const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the history pane harness is wired into npm and CI', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['check:history-ui'], 'electron scripts/check-history-ui.js');

  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm run check:history-ui/);

  const script = read('scripts/check-history-ui.js');
  assert.match(script, /History UI behavior passed:/);
  assert.match(script, /app\.exit\(1\)/, 'a failure exits non-zero');
});

test('the history harness covers the behaviours the pane promises', () => {
  const script = read('scripts/check-history-ui.js');
  for (const marker of [
    'meeting-history-search',
    'ArrowDown',
    'meeting-view-toggle',
    'history-text-before',
    'meeting-participant',
    'meeting-discard-cleaned',
    'meeting-history-delete-selected',
  ]) {
    assert.ok(script.includes(marker), `${marker} is exercised`);
  }
});
