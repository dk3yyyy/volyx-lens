const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const pkg = require('../package.json');

test('macOS accessory behavior is configured before overlay window creation', () => {
  const ready = main.indexOf("app.whenReady().then(() => {");
  const dock = main.indexOf('app.dock.hide()', ready);
  const accessory = main.indexOf("app.setActivationPolicy('accessory')", ready);
  const create = main.indexOf('createWindow();', ready);
  assert.ok(ready >= 0 && dock > ready && accessory > dock && create > accessory);
  assert.match(main, /if \(process\.platform === 'darwin'\)/);
  assert.equal(pkg.build.mac.extendInfo.LSUIElement, true);
});

test('window metadata uses a neutral title in both main and renderer', () => {
  assert.match(main, /const WINDOW_TITLE = 'Utility'/);
  assert.match(main, /title: WINDOW_TITLE/);
  assert.match(main, /win\.setTitle\(WINDOW_TITLE\)/);
  assert.match(html, /<title>Utility<\/title>/);
  assert.doesNotMatch(html, /<title>\s*volyx-lens\s*<\/title>/i);
});

test('capture protection, global shortcuts, and Volyx Lens packaged identity remain intact', () => {
  assert.match(main, /VOLYX_LENS_NO_PROTECT/);
  assert.match(main, /accelerator: 'CommandOrControl\+Return'/);
  assert.match(main, /accelerator: 'CommandOrControl\+H'/);
  assert.match(main, /accelerator: 'CommandOrControl\+Shift\+X'/);
  assert.equal(pkg.build.productName, 'Volyx Lens');
  assert.equal(pkg.build.appId, 'ai.volyx.lens');
  assert.equal(Object.hasOwn(pkg.build.mac, 'executableName'), false);
});
