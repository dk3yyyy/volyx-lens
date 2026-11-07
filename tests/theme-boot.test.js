const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const bootPath = path.join(root, 'renderer', 'theme-boot.js');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function runBoot({ hint, arg, reloaded = false } = {}) {
  const source = fs.readFileSync(bootPath, 'utf8');
  const attrs = {};
  const window = {
    volyxLens: arg === undefined ? undefined : { initialAccentTheme: arg },
    localStorage: { getItem: () => hint },
    sessionStorage: { getItem: () => (reloaded ? '1' : null), setItem: () => {} },
  };
  const document = { documentElement: { setAttribute: (name, value) => { attrs[name] = value; } } };
  const localStorage = window.localStorage;
  const sessionStorage = window.sessionStorage;
  vm.runInNewContext(source, { window, document, localStorage, sessionStorage });
  return { theme: attrs['data-accent-theme'], source: window.__volyxThemeBoot && window.__volyxThemeBoot.source };
}

test('the boot script runs before the stylesheet and is self-hosted', () => {
  const script = html.indexOf('<script src="theme-boot.js"');
  const stylesheet = html.indexOf('href="styles.css"');
  assert.ok(script !== -1, 'theme-boot.js is linked');
  assert.ok(script < stylesheet, 'the boot script is before the stylesheet');
  assert.doesNotMatch(html.slice(script, html.indexOf('</script>', script)), /\n\s*[^<\s]/);
});

test('the boot script trusts the store on a cold start and the hint on a reload', () => {
  assert.deepEqual(runBoot({ hint: 'sage', arg: 'ember' }), { theme: 'ember', source: 'argv' });
  assert.deepEqual(runBoot({ hint: 'ember', arg: 'indigo', reloaded: true }), { theme: 'ember', source: 'hint' });
  assert.deepEqual(runBoot({ arg: 'sage' }), { theme: 'sage', source: 'argv' });
  assert.deepEqual(runBoot({ hint: 'neon', arg: 'neon' }), { theme: 'sage', source: 'default' });
  assert.deepEqual(runBoot({}), { theme: 'sage', source: 'default' });
  assert.deepEqual(runBoot({ hint: 'Indigo' }), { theme: 'sage', source: 'default' });
});

test('prototype keys are not theme ids', () => {
  for (const value of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.deepEqual(runBoot({ hint: value }), { theme: 'sage', source: 'default' }, value);
  }
});

test('preload exposes one validated accent value from the appended argument', () => {
  const originalLoad = Module._load;
  const originalArgv = process.argv.slice();
  let exposed;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return { contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } }, ipcRenderer: { invoke: () => {}, send: () => {}, on: () => {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  process.argv.push('--volyx-accent=ember');
  try {
    delete require.cache[require.resolve('../preload')];
    require('../preload');
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
  }
  assert.equal(exposed.initialAccentTheme, 'ember');
});

test('main passes the normalised theme before the window is created', () => {
  const argument = main.search(/additionalArguments:\s*\[`--volyx-accent=/);
  const declaration = main.search(/const initialAccentTheme = normalizeAccentTheme/);
  const window = main.indexOf('win = new BrowserWindow({');
  assert.ok(argument !== -1, 'additionalArguments is present');
  assert.ok(declaration !== -1 && declaration < window, 'the theme is read before the window is created');
  assert.ok(argument > window, 'the argument is in the webPreferences block');
  assert.match(main.slice(declaration, declaration + 160), /normalizeAccentTheme/);
});
