const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('onboarding buttons request native microphone and screen permissions', () => {
  assert.match(renderer, /requestPermission\('microphone'\)/);
  assert.match(renderer, /requestPermission\('screen'\)/);
  assert.match(renderer, /Request Microphone access/);
  assert.match(renderer, /Request Screen Recording access/);
});

test('permission request crosses a narrow invoke IPC boundary', () => {
  assert.match(preload, /requestPermission:\s*\(kind\)\s*=>\s*ipcRenderer\.invoke\('permissions:request', kind\)/);
  assert.match(main, /ipcMain\.handle\('permissions:request'/);
});

test('application declares only permissions it actually requests', () => {
  assert.equal(pkg.build.mac.extendInfo.NSCameraUsageDescription, undefined);
  assert.match(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription, /microphone/i);
  assert.doesNotMatch(html, /camera permission/i);
});
