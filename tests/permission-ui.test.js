const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const onboardingHarness = fs.readFileSync(path.join(root, 'scripts', 'check-onboarding-ui.js'), 'utf8');

test('onboarding buttons request native microphone and screen permissions', () => {
  assert.match(renderer, /requestPermission\('microphone'\)/);
  assert.match(renderer, /requestPermission\('screen'\)/);
  assert.match(renderer, /kind: 'microphone', icon: 'mic', label: 'Microphone'/);
  assert.match(renderer, /kind: 'screen', icon: 'camera', label: 'Screen Recording'/);
});

test('onboarding uses an accessible split setup layout with clear progress and permission cards', () => {
  for (const id of ['ob-brand-mark', 'ob-step-label', 'ob-stage', 'ob-content', 'ob-title', 'ob-body', 'ob-buttons', 'ob-permission-status']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="onboard"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="ob-title"/);
  assert.match(renderer, /stepLabel:\s*'Permissions'/);
  assert.match(renderer, /icon:\s*'mic'/);
  assert.match(renderer, /permission-card/);
  assert.match(renderer, /ob-step-label/);
  assert.match(renderer, /aria-current/);
});

test('onboarding dialog declares and implements keyboard focus containment and restoration', () => {
  assert.match(html, /id="ob-title"[^>]*tabindex="-1"/);
  assert.doesNotMatch(html, /id="ob-content"[^>]*aria-live/);
  assert.match(html, /id="ob-permission-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(renderer, /function handleOnboardKeydown\(event\)/);
  assert.match(renderer, /event\.key !== 'Tab'/);
  assert.match(renderer, /event\.key === 'Escape'/);
  assert.match(renderer, /requestAnimationFrame\(\(\) => \{/);
  assert.match(renderer, /document\.activeElement !== title/);
  assert.match(renderer, /obPreviousFocus && obPreviousFocus\.isConnected/);
  assert.match(styles, /button:focus-visible[\s\S]*outline:\s*2px solid var\(--cyan\)/);
  assert.doesNotMatch(styles, /button:focus\s*\{\s*outline:\s*none/);
  assert.match(onboardingHarness, /Shift\+Tab from the heading should wrap to the last visible control/);
  assert.match(onboardingHarness, /global Settings shortcut must be suppressed while onboarding is open/);
  assert.match(onboardingHarness, /closing onboarding should restore focus/);
  assert.equal(pkg.scripts['check:onboarding-ui'], 'electron scripts/check-onboarding-ui.js');
});

test('onboarding honors reduced motion and constrains resizable compact layouts', () => {
  assert.match(styles, /prefers-reduced-motion:\s*reduce[\s\S]*#onboard[\s\S]*\.ob-orbit::before/);
  assert.match(styles, /@media \(max-width:\s*560px\)[\s\S]*\.ob-footer[\s\S]*grid-template-rows:\s*auto auto/);
  assert.match(main, /minWidth:\s*500/);
  assert.match(main, /minHeight:\s*480/);
});

test('permission actions expose optionality and visible text states', () => {
  assert.match(renderer, /Each permission is optional/);
  assert.match(renderer, /permissionStates = \{[\s\S]*microphone: \{ text: 'Not requested', className: '' \}[\s\S]*screen: \{ text: 'Not requested', className: '' \}/);
  assert.match(renderer, /trailing\.className = `ob-permission-state \$\{state\.className\}`/);
  for (const state of ['Requesting…', 'Granted', 'Needs settings', 'Unavailable', 'Request failed']) {
    assert.match(renderer, new RegExp(state));
  }
  assert.match(styles, /\.ob-permission-state\.granted/);
  assert.match(styles, /\.ob-permission-state\.denied/);
});

test('permission request crosses a narrow invoke IPC boundary', () => {
  assert.match(preload, /requestPermission:\s*\(kind\)\s*=>\s*ipcRenderer\.invoke\('permissions:request', kind\)/);
  assert.match(main, /handleTrusted\('permissions:request'/);
});

test('application declares only permissions it actually requests', () => {
  assert.equal(pkg.build.mac.extendInfo.NSCameraUsageDescription, undefined);
  assert.match(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription, /microphone/i);
  assert.doesNotMatch(html, /camera permission/i);
});
