'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const brandTest = read('tests/brand-identity.test.js');
const onboarding = read('scripts/check-onboarding-ui.js');
const settings = read('scripts/check-settings-ui.js');
const history = read('scripts/check-history-ui.js');
const smoke = read('scripts/e2e-smoke.js');

const retiredIdentifier = String.fromCharCode(99, 117, 101);

test('generated output is not scanned as source', () => {
  assert.match(brandTest, /ignoredDirectories = new Set\(\[[^\]]*'coverage'/);
  assert.match(brandTest, /ignoredDirectories = new Set\(\[[^\]]*'\.nyc_output'/);
  // build/ holds entitlements and icons, which are source we edit.
  assert.doesNotMatch(brandTest, /ignoredDirectories = new Set\(\[[^\]]*'build'/);
});

test('a coverage tree does not turn the identity check red', () => {
  // The exact failure mode: c8 writes a bundled prettify.js whose token list
  // contains the retired identifier inside another word.
  const directory = path.join(root, 'coverage');
  const planted = [
    path.join(directory, 'lcov-report', 'prettify.js'),
    path.join(directory, 'prettify.js'),
  ];
  const existed = fs.existsSync(directory);
  try {
    for (const file of planted) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `// reserved word list: ...,${retiredIdentifier},...\n`);
    }
    const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', '.nyc_output', '__MACOSX']);
    const findings = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && ignored.has(entry.name)) continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (/\.(js|json|md|html|css|yml|yaml|plist|swift)$/.test(entry.name)
          && fs.readFileSync(target, 'utf8').toLowerCase().includes(retiredIdentifier)) {
          findings.push(path.relative(root, target));
        }
      }
    }(root));
    assert.deepEqual(findings.filter((file) => file.startsWith('coverage/')), [], 'a generated coverage tree is skipped');
  } finally {
    if (!existed) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the compact onboarding measurement waits for the open animation', () => {
  const start = onboarding.indexOf('win.setSize(500, 480)');
  assert.ok(start > 0, 'the compact case is exercised');
  const body = onboarding.slice(start, start + 400);
  assert.match(body, /await waitForStableDialogHeight\(win\)/, 'measuring mid-animation is a flake, not a regression');
  assert.doesNotMatch(body, /await wait(100);/, 'the fixed wait that measured at 100ms is gone');
});

test('every harness stubs the boot-time history fetch', () => {
  for (const [name, source] of [['settings', settings], ['onboarding', onboarding], ['e2e smoke', smoke]]) {
    assert.match(source, /ipcMain\.handle\('history:list'/, `${name} stubs history:list`);
    assert.match(source, /ipcMain\.handle\('history:limits'/, `${name} stubs history:limits`);
  }
});

test('the history search waits for the debounce instead of sleeping', () => {
  assert.doesNotMatch(history, /await wait\(200\);\n  const mangoRows/, 'the narrowing assertion must not race the debounce');
  assert.match(history, /waitFor\(win, "document\.querySelectorAll\('#meeting-history-list \.history-entry'\)\.length === 1", 'the cleaned-copy search to narrow the list'\)/);
  assert.match(history, /'the cleared search to show both meetings'/);
});
