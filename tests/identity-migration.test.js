const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { migrateLegacyUserData } = require('../src/identity-migration');

function temporaryRoot() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-lens-migration-')));
}

test('Volyx Lens identity is complete across package and release metadata', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-macos.yml'), 'utf8');
  assert.equal(pkg.name, 'volyx-lens');
  assert.equal(pkg.author, 'VolyxAI');
  assert.equal(pkg.build.productName, 'Volyx Lens');
  assert.equal(pkg.build.appId, 'ai.volyx.lens');
  assert.equal(pkg.build.artifactName, 'volyx-lens-${version}-${os}-${arch}.${ext}');
  assert.deepEqual(pkg.build.extraResources, [{ from: 'native-bin', to: 'native', filter: ['volyx-lens-vision-ocr', 'volyx-lens-system-audio'] }]);
  assert.ok(pkg.build.mac.binaries.includes('Contents/Resources/native/volyx-lens-vision-ocr'));
  assert.ok(pkg.build.mac.binaries.includes('Contents/Resources/native/volyx-lens-system-audio'));
  assert.match(workflow, /Volyx Lens\.app/);
  assert.match(workflow, /ai\.volyx\.lens/);
  assert.match(workflow, /volyx-lens-macos-\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /macos-15-intel[\s\S]*arch: x64/);
  assert.match(workflow, /actions\/attest@v4/);
  assert.match(workflow, /Attest build provenance[\s\S]*subject-path:[^\n]+[\s\S]*Attest signed archive SBOM/);
  assert.match(workflow, /\(cd dist && shasum -a 256 "\$ZIP_NAME"/);
  assert.match(workflow, /VOLYX_LENS_RENDERER_READY/);
  assert.match(workflow, /gh release create/);
});

test('legacy Volyx Lens data is copied once without overwriting current Volyx Lens data', () => {
  const root = temporaryRoot();
  const legacyUserData = path.join(root, 'volyx-lens');
  const currentUserData = path.join(root, 'Volyx Lens');
  fs.mkdirSync(legacyUserData, { recursive: true });
  fs.writeFileSync(path.join(legacyUserData, 'volyx-lens-data.json'), '{"provider":"azure"}', { mode: 0o600 });
  fs.writeFileSync(path.join(legacyUserData, 'personal-context.json'), '{"mode":"safeStorage"}', { mode: 0o600 });

  const first = migrateLegacyUserData({ legacyUserData, currentUserData });
  assert.deepEqual(first.migrated.sort(), ['personal-context.json', 'volyx-lens-data.json']);
  assert.equal(fs.readFileSync(path.join(currentUserData, 'volyx-lens-data.json'), 'utf8'), '{"provider":"azure"}');
  assert.equal(fs.statSync(path.join(currentUserData, 'volyx-lens-data.json')).mode & 0o777, 0o600);

  fs.writeFileSync(path.join(currentUserData, 'volyx-lens-data.json'), '{"provider":"openai"}', { mode: 0o600 });
  const second = migrateLegacyUserData({ legacyUserData, currentUserData });
  assert.deepEqual(second.migrated, []);
  assert.equal(fs.readFileSync(path.join(currentUserData, 'volyx-lens-data.json'), 'utf8'), '{"provider":"openai"}');
});

test('legacy migration rejects symlinks and oversized files', () => {
  const root = temporaryRoot();
  const legacyUserData = path.join(root, 'volyx-lens');
  const currentUserData = path.join(root, 'Volyx Lens');
  fs.mkdirSync(legacyUserData, { recursive: true });
  const target = path.join(root, 'target.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, path.join(legacyUserData, 'volyx-lens-data.json'));
  fs.writeFileSync(path.join(legacyUserData, 'personal-context.json'), 'x'.repeat(1025));
  const result = migrateLegacyUserData({ legacyUserData, currentUserData, maxBytes: 1024 });
  assert.deepEqual(result.migrated, []);
  assert.equal(fs.existsSync(path.join(currentUserData, 'volyx-lens-data.json')), false);
  assert.equal(fs.existsSync(path.join(currentUserData, 'personal-context.json')), false);
});

test('legacy migration rejects symlinked source and destination directories', () => {
  const root = temporaryRoot();
  const realLegacy = path.join(root, 'real-volyx-lens');
  const linkedLegacy = path.join(root, 'volyx-lens');
  const currentUserData = path.join(root, 'Volyx Lens');
  fs.mkdirSync(realLegacy, { recursive: true });
  fs.writeFileSync(path.join(realLegacy, 'volyx-lens-data.json'), '{"provider":"azure"}');
  fs.symlinkSync(realLegacy, linkedLegacy, 'dir');
  assert.deepEqual(migrateLegacyUserData({ legacyUserData: linkedLegacy, currentUserData }).migrated, []);
  assert.equal(fs.existsSync(path.join(currentUserData, 'volyx-lens-data.json')), false);

  const ordinaryLegacy = path.join(root, 'ordinary-volyx-lens');
  const redirectedDestination = path.join(root, 'redirected-destination');
  const linkedDestination = path.join(root, 'linked-volyx-lens');
  fs.mkdirSync(ordinaryLegacy, { recursive: true });
  fs.mkdirSync(redirectedDestination, { recursive: true });
  fs.writeFileSync(path.join(ordinaryLegacy, 'volyx-lens-data.json'), '{"provider":"azure"}');
  fs.symlinkSync(redirectedDestination, linkedDestination, 'dir');
  assert.deepEqual(migrateLegacyUserData({ legacyUserData: ordinaryLegacy, currentUserData: linkedDestination }).migrated, []);
  assert.equal(fs.existsSync(path.join(redirectedDestination, 'volyx-lens-data.json')), false);
});