'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createThemSilenceWatchdog } = require('../renderer/them-silence-watchdog');
const captureGuards = require('../renderer/capture-guards');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

function createHarness(options = {}) {
  let clock = 0;
  const notices = [];
  const restarts = [];
  const watchdog = createThemSilenceWatchdog({
    silenceMs: 15000,
    retryCooldownMs: 30000,
    ...options,
    now: () => clock,
    onSilence: (event) => notices.push({ ...event, at: clock }),
    restart: (event) => restarts.push({ ...event, at: clock }),
  });
  return {
    watchdog,
    notices,
    restarts,
    advance(ms) { clock += ms; },
    now: () => clock,
  };
}

// Feeds `ms` of exact-zero frames in 100 ms steps, the cadence a stopped
// loopback/helper still delivers.
function feedSilence(harness, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    harness.advance(100);
    harness.watchdog.feed(0);
  }
}

test('a zero-buffer episode after real audio sends one notice and one bounded retry', () => {
  const harness = createHarness();
  harness.watchdog.arm(true);
  harness.watchdog.feed(900); // the channel carried sound in this session

  harness.advance(5000);
  harness.watchdog.feed(0);
  feedSilence(harness, 14900);
  assert.equal(harness.notices.length, 0, 'nothing is reported before the 15 s window elapses');

  harness.advance(200);
  harness.watchdog.feed(0);
  assert.equal(harness.notices.length, 1, 'exactly one notice per episode');
  assert.equal(harness.restarts.length, 0, 'a mute is not restarted on the notice alone');

  // Only a source that never comes back is restarted, once.
  harness.advance(45000);
  harness.watchdog.feed(0);
  assert.equal(harness.restarts.length, 1, 'exactly one restart attempt per episode');

  // A source that keeps delivering zeros must not loop the notice or retry.
  feedSilence(harness, 60000);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.restarts.length, 1);
  assert.equal(harness.watchdog.status().notices, 1);
  assert.equal(harness.watchdog.status().restarts, 1);
});

test('low-level noise is not digital silence and never triggers a reconnect', () => {
  const harness = createHarness();
  harness.watchdog.arm(true);
  harness.watchdog.feed(900);
  for (let elapsed = 0; elapsed < 60000; elapsed += 100) {
    harness.advance(100);
    harness.watchdog.feed(2); // a live noise floor, below the sound floor but non-zero
  }
  assert.equal(harness.notices.length, 0);
  assert.equal(harness.restarts.length, 0);
  assert.equal(harness.watchdog.status().carriedSound, true);
  assert.equal(harness.watchdog.status().silentForMs, 0);
});

test('a noise blip breaks a zero run so it must be continuous for 15 s', () => {
  const harness = createHarness();
  harness.watchdog.arm(true);
  harness.watchdog.feed(900);
  feedSilence(harness, 14500);
  harness.advance(100);
  harness.watchdog.feed(1); // one frame of low-level noise breaks continuity
  feedSilence(harness, 14500);
  assert.equal(harness.notices.length, 0);
  assert.equal(harness.restarts.length, 0);
});

test('a mic-only session never arms the watchdog', () => {
  const harness = createHarness();
  harness.watchdog.arm(false);
  harness.watchdog.feed(900);
  feedSilence(harness, 60000);
  assert.equal(harness.notices.length, 0);
  assert.equal(harness.restarts.length, 0);
  assert.equal(harness.watchdog.status().armed, false);
});

test('pre-session zeros do not trigger before any sound has been carried', () => {
  const harness = createHarness();
  harness.watchdog.arm(true);
  feedSilence(harness, 60000);
  assert.equal(harness.notices.length, 0);
  assert.equal(harness.restarts.length, 0);
});

test('stop clears the episode, and the next session must carry sound again', () => {
  const harness = createHarness();
  harness.watchdog.arm(true);
  harness.watchdog.feed(900);
  feedSilence(harness, 60200);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.restarts.length, 1);

  harness.watchdog.disarm();
  assert.equal(harness.watchdog.status().armed, false);
  assert.equal(harness.watchdog.status().carriedSound, false);
  assert.equal(harness.watchdog.status().noticeSent, false);
  feedSilence(harness, 60000);
  assert.equal(harness.notices.length, 1, 'a stopped capture reports nothing');
  assert.equal(harness.restarts.length, 1);

  harness.watchdog.arm(true);
  feedSilence(harness, 60000);
  assert.equal(harness.notices.length, 1, 'a fresh session starts without carried sound');
  harness.watchdog.feed(900);
  harness.advance(100);
  feedSilence(harness, 15100);
  assert.equal(harness.notices.length, 2);
});

test('session change and source restart reset the episode without resetting the cooldown', () => {
  const harness = createHarness();
  harness.watchdog.arm(true);
  harness.watchdog.feed(900);
  feedSilence(harness, 60200);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.restarts.length, 1);

  // Session change / source restart while capture continues.
  harness.watchdog.reset();
  feedSilence(harness, 30000);
  assert.equal(harness.notices.length, 1, 'reset forgets the carried sound from the old episode');

  harness.watchdog.feed(900);
  feedSilence(harness, 60200);
  assert.equal(harness.notices.length, 2);
  assert.equal(harness.restarts.length, 2, 'a later episode may retry');
});

test('a mute that recovers is never restarted', () => {
  const harness = createHarness();
  harness.watchdog.arm(true);
  harness.watchdog.feed(900);
  feedSilence(harness, 30000); // a muted call: notice, but no reconnect yet
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.restarts.length, 0, 'a 30 s mute is ordinary call behaviour');

  harness.watchdog.feed(900); // the remote speaks again
  feedSilence(harness, 60000);
  assert.equal(harness.restarts.length, 0, 'a healthy source that recovered is left alone');
});

test('main feeds and resets the watchdog around the capture lifecycle', () => {
  assert.match(main, /const \{ createThemSilenceWatchdog \} = require\('\.\/renderer\/them-silence-watchdog'\)/);
  assert.match(main, /themSilenceWatchdog\.feed\(rms16\(pcm\)\)/);
  assert.match(main, /themSilenceWatchdog\.arm\(audio\.systemEnabled !== false\)/);
  assert.match(main, /state\.capturing = false;[\s\S]{0,80}themSilenceWatchdog\.disarm\(\)/);
  assert.match(main, /async function restartThemAudioSource\(\)[\s\S]*?themSilenceWatchdog\.reset\(\)[\s\S]*?systemAudioCapture\.stop\(\{ immediate: true \}\)[\s\S]*?systemAudioCapture\.start\(\)/);
  // Linux stop() resolves before the child exits; the restart must wait for the
  // stopped state instead of racing start() against a held child.
  assert.ok(main.includes('if (!(await stopped))'), 'a stop timeout is not treated as a clean stop');
  assert.ok(main.includes('captureGeneration === restartCapture'), 'a restart is cancelled by capture changes, not by a new transcript session');
  assert.ok(main.includes('result = await linuxMonitorCapture.start()'));
  assert.match(main, /sourceState === 'stopped' \|\| sourceState === 'failed'\) resolveLinuxSourceStopWaiters\(\)/);
  assert.match(main, /audio\.systemEnabled === false\) return null/);
  assert.match(main, /System audio stopped; reconnecting/);
  assert.match(main, /\/\/ A new session is a new silence episode[\s\S]*?themSilenceWatchdog\.reset\(\)/);
});

test('Windows loopback requests restrictOwnAudio; other platforms keep plain audio', () => {
  const windows = captureGuards.displayMediaConstraints('win32');
  assert.deepEqual(windows, { video: true, audio: { restrictOwnAudio: true } });

  for (const platform of ['darwin', 'linux']) {
    const other = captureGuards.displayMediaConstraints(platform);
    assert.deepEqual(other, { video: true, audio: true });
    assert.doesNotMatch(JSON.stringify(other), /restrictOwnAudio/);
  }

  assert.match(renderer, /getDisplayMedia\(captureGuards\.displayMediaConstraints\(volyxLens\.platform\)\)/);
  assert.doesNotMatch(renderer, /getDisplayMedia\(\{ video: true, audio: true \}\)/);
  assert.ok(html.indexOf('<script src="capture-guards.js"></script>') !== -1, 'the guard module is loaded by the renderer');
  assert.ok(html.indexOf('<script src="capture-guards.js"></script>') < html.indexOf('<script src="renderer.js"></script>'), 'guards load before renderer.js');
});

test('a zero-channel input device is rejected in favour of the default microphone', () => {
  assert.equal(captureGuards.hasNoInputChannels({ channelCount: 0 }), true);
  assert.equal(captureGuards.hasNoInputChannels({ getSettings: () => ({ channelCount: 0 }) }), true);
  assert.equal(captureGuards.hasNoInputChannels({ channelCount: 1 }), false);
  assert.equal(captureGuards.hasNoInputChannels({}), false, 'an unreported count is not a rejection');
  assert.equal(captureGuards.hasNoInputChannels({ getSettings: () => ({}) }), false);

  const devices = [
    { kind: 'audioinput', deviceId: 'zero', channelCount: 0 },
    { kind: 'audioinput', deviceId: 'good', channelCount: 1 },
    { kind: 'audiooutput', deviceId: 'speaker', channelCount: 0 },
  ];
  assert.deepEqual(captureGuards.chooseInputDevice(devices, 'zero'), { deviceId: '', rejected: 'no-input-channels' });
  assert.deepEqual(captureGuards.chooseInputDevice(devices, 'good'), { deviceId: 'good', rejected: null });
  assert.deepEqual(captureGuards.chooseInputDevice(devices, ''), { deviceId: '', rejected: null });
  assert.equal(captureGuards.isSelectableInput(devices[2]), false);

  const fallback = captureGuards.inputDeviceFallback('zero', { getSettings: () => ({ channelCount: 0 }) });
  assert.equal(fallback.reason, 'no-input-channels');
  assert.equal(fallback.deviceId, '');
  assert.match(fallback.message, /no input channels/);
  assert.equal(captureGuards.inputDeviceFallback('zero', { channelCount: 1 }), null);
  assert.equal(captureGuards.inputDeviceFallback('', { channelCount: 0 }), null, 'the default device is not re-rejected');

  // The renderer opens a default-device stream after the rejection and says why.
  assert.match(renderer, /if \(deviceFallback\) \{[\s\S]*?getUserMedia\(\{ audio: \{[\s\S]*?\} \}\);/);
  assert.match(renderer, /inputDeviceFallback\(requestedDeviceId/);
  assert.match(renderer, /showStatus\(deviceFallback\.message\)/);
});
