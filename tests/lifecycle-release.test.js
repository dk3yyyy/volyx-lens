const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const pkg = require('../package.json');
const releaseWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-macos.yml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('main process—not a throttled renderer—enforces billing warning and session stop timers', () => {
  assert.match(main, /function scheduleCaptureTimers\(\)/);
  assert.match(main, /captureWarningTimer = setTimeout/);
  assert.match(main, /captureLimitTimer = setTimeout/);
  assert.match(main, /setCapturing\(false\)/);
  assert.doesNotMatch(renderer, /elapsedMinutes >=/);
});

test('sleep, lock, shutdown, and quit stop capture without silently restarting on wake', () => {
  assert.match(main, /powerMonitor\.on\('suspend'/);
  assert.match(main, /powerMonitor\.on\('lock-screen'/);
  assert.match(main, /powerMonitor\.on\('shutdown'/);
  assert.match(main, /powerMonitor\.on\('resume'[\s\S]*Listening remains off/);
  assert.match(main, /powerMonitor\.on\('unlock-screen'[\s\S]*Listening remains off/);
  assert.match(main, /stopCaptureForSystem[\s\S]*setCapturing\(false, \{ immediate: true, reason \}\)/);
});

test('capture transitions and active New Session replacement share one serialized queue', () => {
  assert.match(main, /captureTransition = captureTransition\.then\(reconcileCaptureState/);
  assert.match(main, /function startNewSession[\s\S]*captureTransition = captureTransition\.then\(operation, operation\)/);
  assert.match(main, /if \(state\.capturing\) await stopTranscriptionPipeline\(\{ immediate: true \}\)/);
  assert.match(main, /if \(restartTranscription && state\.capturing && desiredCapturing\) startTranscriptionPipeline\(\)/);
});

test('permission recovery exposes an explicit user-triggered relaunch action', () => {
  assert.match(preload, /relaunch: \(\) => ipcRenderer\.send\('app:relaunch'\)/);
  assert.match(renderer, /Restart Volyx Lens/);
  assert.match(renderer, /volyxLens\.relaunch\(\)/);
  assert.match(main, /function relaunchApp[\s\S]*app\.relaunch\(\)[\s\S]*app\.exit\(0\)/);
});

test('long meeting recap discloses request count and requires explicit renderer confirmation', () => {
  assert.match(preload, /recapPlan: \(\) => ipcRenderer\.invoke\('recap:plan'\)/);
  assert.match(renderer, /window\.confirm\(`This long-meeting recap will make \$\{plan\.requestCount\} model requests/);
  assert.match(main, /if \(!confirmedLongRecap\) throw new Error/);
});

test('release scripts gate signing credentials and preserve hardened runtime/notarization', () => {
  assert.equal(pkg.build.mac.hardenedRuntime, true);
  assert.equal(pkg.build.mac.notarize, true);
  assert.match(pkg.scripts['release:mac'], /--require-credentials/);
  assert.match(pkg.scripts['release:mac'], /--publish never/);
  assert.match(pkg.scripts['release:verify'], /verify-macos-release/);
  assert.match(releaseWorkflow, /environment: macos-release/);
  assert.match(releaseWorkflow, /concurrency:/);
  assert.match(releaseWorkflow, /ditto -x -k/);
  assert.match(releaseWorkflow, /CFBundleIdentifier/);
});

test('documented Node version matches the tested packaging runtime', () => {
  assert.equal(pkg.engines.node, '>=20');
  assert.match(readme, /Node\.js\]\([^)]*\) 20\+ installed/);
});
