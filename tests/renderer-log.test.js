'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRendererLogForwarder, sanitizeRendererLog } = require('../src/renderer-log');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('a huge payload is truncated instead of filling the log', () => {
  const lines = [];
  const forwarder = createRendererLogForwarder({ write: (line) => lines.push(line) });
  const result = forwarder.forward('x'.repeat(1024 * 1024));
  assert.equal(result.forwarded, true);
  assert.equal(lines[0].length, '[renderer] '.length + 2048, 'one megabyte becomes two kilobytes');
});

test('control characters cannot forge another log line', () => {
  const lines = [];
  const forwarder = createRendererLogForwarder({ write: (line) => lines.push(line) });
  forwarder.forward('honest line\n[error] forged line\r\u001b[31mred');
  assert.equal(lines.length, 1, 'one call still produces one line');
  assert.doesNotMatch(lines[0].slice('[renderer] '.length), /[\n\r\u001b]/, 'no newline, carriage return or escape survives');
  assert.match(lines[0], /honest line \[error\] forged line/, 'the text is kept, flattened');
});

test('a flood is rate limited and says so once', () => {
  const lines = [];
  let clock = 0;
  const forwarder = createRendererLogForwarder({ write: (line) => lines.push(line), now: () => clock, maxPerWindow: 3 });
  for (let index = 0; index < 10; index += 1) forwarder.forward(`line ${index}`);
  assert.equal(lines.filter((line) => line.startsWith('[renderer] line')).length, 3, 'three get through');
  assert.equal(lines.length, 4, 'plus one suppression notice');
  // The notice fires on the first drop, so it reports that drop rather than the total.
  assert.match(lines[3], /1 log line suppressed/);
  assert.equal(lines.filter((line) => /suppressed/.test(line)).length, 1, 'and it does not repeat');
  // The window resets, so a later burst is not silenced forever.
  clock += 20000;
  forwarder.forward('after the window');
  assert.match(lines[lines.length - 1], /after the window/);
});

test('nulls and undefined do not crash the forwarder', () => {
  assert.equal(sanitizeRendererLog(null), '');
  assert.equal(sanitizeRendererLog(undefined), '');
  assert.equal(sanitizeRendererLog({ toString: () => 'object' }), 'object');
});

test('main forwards renderer logs through the sanitizer', () => {
  assert.match(main, /createRendererLogForwarder/);
  assert.match(main, /onTrusted\('log', \(_e, msg\) => rendererLog\.forward\(msg\)\)/);
  assert.doesNotMatch(main, /onTrusted\('log', \(_e, msg\) => console\.log\('\[renderer\]', msg\)\)/);
});

test('display intent is only honoured while a capture is starting or running', () => {
  const handler = main.slice(main.indexOf("onTrusted('capture:display-intent'"), main.indexOf("onTrusted('capture:display-intent'") + 700);
  assert.match(handler, /desiredCapturing !== true/, 'the renderer cannot declare intent outside a capture start');
  assert.match(handler, /pendingDisplayCapture = false;/, 'and a refused intent clears any queued one');
  assert.match(handler, /setTimeout\(/, 'a granted intent expires instead of waiting for the next capture');
});

test('the Windows loopback start asks for capture before declaring display intent', () => {
  // The intent is refused until the main process knows a capture is starting, so
  // the toggle has to be sent first or Windows system audio never gets its track.
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const start = renderer.indexOf("$('#stop-btn').addEventListener");
  const block = renderer.slice(start, start + 1600);
  const toggle = block.indexOf('volyxLens.captureToggle()');
  const audio = block.indexOf('startSystemAudio()');
  assert.ok(toggle > -1, 'the handler requests a capture toggle');
  assert.ok(audio > -1, 'and starts Windows system audio');
  assert.ok(toggle < audio, 'in that order');
});
