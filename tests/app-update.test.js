const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const updateManager = fs.readFileSync(path.join(root, 'src', 'update-manager.js'), 'utf8');
const pkg = require('../package.json');
const releaseWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-macos.yml'), 'utf8');

test('Settings exposes an accessible Updates page and explicit update actions', () => {
  assert.match(html, /data-settings-section="updates"/);
  assert.match(html, /data-settings-page="updates"/);
  assert.match(html, /id="update-current-version"/);
  assert.match(html, /id="update-check"[^>]*>Check for Updates</);
  assert.match(html, /id="update-download"[^>]*hidden/);
  assert.match(html, /id="update-install"[^>]*hidden/);
  assert.match(html, /id="update-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(renderer, /volyxLens\.updateCheck\(\)/);
  assert.match(renderer, /volyxLens\.updateDownload\(\)/);
  assert.match(renderer, /volyxLens\.updateInstall\(\)/);
});

test('preload exposes only narrow update IPC and receives bounded update state', () => {
  assert.match(preload, /updateGetState: \(\) => ipcRenderer\.invoke\('update:get-state'\)/);
  assert.match(preload, /updateCheck: \(\) => ipcRenderer\.invoke\('update:check'\)/);
  assert.match(preload, /updateDownload: \(\) => ipcRenderer\.invoke\('update:download'\)/);
  assert.match(preload, /updateInstall: \(\) => ipcRenderer\.invoke\('update:install'\)/);
  assert.match(preload, /'update:state'/);
  assert.doesNotMatch(preload, /setFeedURL|github\.com|GH_TOKEN/);
});

test('main process gates updater operations to trusted packaged macOS builds', () => {
  assert.match(main, /handleTrusted\('update:get-state'/);
  assert.match(main, /handleTrusted\('update:check'/);
  assert.match(main, /handleTrusted\('update:download'/);
  assert.match(main, /handleTrusted\('update:install'/);
  assert.match(updateManager, /app\.isPackaged/);
  assert.match(updateManager, /platform === 'darwin'/);
  assert.match(updateManager, /releaseBuild === true/);
});

test('release configuration produces and publishes updater metadata with signed archives', () => {
  assert.equal(pkg.dependencies['electron-updater'] != null, true);
  assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'dk3yyyy', repo: 'volyx-lens' }]);
  assert.match(releaseWorkflow, /latest-.*-mac\.yml/);
  assert.match(releaseWorkflow, /volyxReleaseBuild=true/);
  assert.match(releaseWorkflow, /Missing official release-build marker/);
  assert.match(releaseWorkflow, /validate-update-metadata\.js/);
  assert.match(releaseWorkflow, /gh release create/);
});
