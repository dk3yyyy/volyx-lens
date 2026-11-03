const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_STDOUT_BYTES,
  OCR_REASON_LABELS,
  OCR_REASON_FALLBACK,
  ocrReasonLabel,
  decodeImageDataUrl,
  validateVisionHelper,
  runVisionHelper,
  createLocalOcr,
} = require('../src/local-ocr');


// The host's own node binary is not a usable fixture: a setup-node install can
// put a symlink in the helper's path, which the darwin validation rejects on
// purpose. A real file is what this contract is about.
function helperFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-ocr-helper-'));
  const helper = path.join(dir, 'volyx-lens-vision-ocr');
  fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return helper;
}

function image(value = 'screen') {
  return `data:image/png;base64,${Buffer.from(value).toString('base64')}`;
}

function fakeChild(onInput = null) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (input) => { if (onInput) onInput(child, input); };
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    setImmediate(() => child.emit('close', null));
    return true;
  };
  return child;
}

test('local OCR validates image data and platform-specific helper permissions', () => {
  assert.deepEqual(decodeImageDataUrl(image('abc')), Buffer.from('abc'));
  assert.throws(() => decodeImageDataUrl('https://example.test/screen.png'), /invalid_image/);
  assert.equal(validateVisionHelper(helperFixture(), 'linux').ready, false);
  assert.equal(validateVisionHelper(helperFixture(), 'darwin').ready, true);
});

test('Vision helper receives image bytes over stdin with no shell and returns bounded clean text', async () => {
  let options;
  const spawnImpl = (_helper, args, value) => {
    options = { args, value };
    return fakeChild((child, input) => {
      assert.deepEqual(input, Buffer.from('screen'));
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, text: ' line one\r\nline\u0000 two ' })));
        child.emit('close', 0);
      });
    });
  };
  const result = await runVisionHelper({ helper: '/private/helper', image: Buffer.from('screen'), spawnImpl });
  assert.deepEqual(result, { status: 'ready', text: 'line one\nline two', truncated: false });
  assert.deepEqual(options.args, []);
  assert.equal(options.value.shell, false);
  assert.deepEqual(options.value.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(Object.keys(options.value.env).sort(), ['HOME', 'LANG', 'PATH']);
});

test('Vision helper output is bounded and raw stderr is never returned', async () => {
  const spawnImpl = () => fakeChild((child) => {
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('sensitive native details'));
      child.stdout.emit('data', Buffer.alloc(MAX_STDOUT_BYTES + 1, 65));
    });
  });
  const result = await runVisionHelper({ helper: '/private/helper', image: Buffer.from('screen'), spawnImpl });
  assert.deepEqual(result, { status: 'failed', reason: 'output_oversized' });
  assert.doesNotMatch(JSON.stringify(result), /sensitive native details/);
});

test('local OCR serializes work and individual cancellation releases queued captures', async () => {
  const children = [];
  const runner = createLocalOcr({
    platform: 'darwin',
    helperPath: helperFixture(),
    spawnImpl: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  const first = runner.recognize(image('first'), { jobId: 'tc-1' });
  const second = runner.recognize(image('second'), { jobId: 'tc-2' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 1);
  assert.equal(runner.cancel('tc-2'), true);
  assert.deepEqual(await second, { status: 'cancelled' });
  children[0].stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, text: 'first result' })));
  children[0].emit('close', 0);
  assert.deepEqual(await first, { status: 'ready', text: 'first result', truncated: false });

  const third = runner.recognize(image('third'), { jobId: 'tc-3' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.cancel('tc-3'), true);
  assert.deepEqual(await third, { status: 'cancelled' });
  assert.deepEqual(children[1].killSignals, ['SIGTERM']);
});

test('local OCR can cancel queued work without interrupting the active job', async () => {
  const children = [];
  const runner = createLocalOcr({
    platform: 'darwin',
    helperPath: helperFixture(),
    spawnImpl: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  const active = runner.recognize(image('active'), { jobId: 'active' });
  const queued = runner.recognize(image('old-slide'), { jobId: 'old-slide' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runner.cancelQueued('old-slide'), true);
  assert.deepEqual(await queued, { status: 'cancelled' });
  assert.deepEqual(children[0].killSignals, []);
  children[0].stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, text: 'active result' })));
  children[0].emit('close', 0);
  assert.deepEqual(await active, { status: 'ready', text: 'active result', truncated: false });
  assert.equal(children.length, 1);
});

test('cancelAll resolves queued OCR immediately and prevents it from spawning', async () => {
  const children = [];
  const runner = createLocalOcr({
    platform: 'darwin',
    helperPath: helperFixture(),
    spawnImpl: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  const active = runner.recognize(image('active'), { jobId: 'tc-1' });
  const queued = runner.recognize(image('queued'), { jobId: 'tc-2' });
  await new Promise((resolve) => setImmediate(resolve));
  runner.cancelAll();
  assert.deepEqual(await queued, { status: 'cancelled' });
  assert.deepEqual(await active, { status: 'cancelled' });
  assert.equal(children.length, 1);
});

test('non-macOS OCR reports unavailable without decoding or spawning', async () => {
  let spawned = false;
  const runner = createLocalOcr({ platform: 'linux', helperPath: '/missing', spawnImpl: () => { spawned = true; } });
  assert.deepEqual(runner.availability(), { available: false, engine: null, reason: 'unsupported_platform' });
  assert.deepEqual(await runner.recognize(image()), { status: 'unavailable', reason: 'unsupported_platform' });
  assert.equal(spawned, false);
});

test('every OCR reason maps to stable user-facing wording with no filesystem paths', () => {
  // Wording is part of the contract: when it changes, this test changes with it
  // rather than the pane drifting to a different sentence per release.
  assert.deepEqual({ ...OCR_REASON_LABELS }, {
    unsupported_platform: 'not available on this platform',
    helper_missing: 'helper not installed in this build',
    unsafe_helper: 'helper failed its safety check',
    spawn_failed: 'helper could not start',
    timeout: 'helper timed out',
    output_oversized: 'helper returned too much data',
    helper_reported_error: 'helper reported an error',
    helper_exit: 'helper stopped unexpectedly',
    invalid_output: 'helper returned unreadable output',
    invalid_image: 'screen image could not be read',
    internal_error: 'recognition failed unexpectedly',
  });
  for (const [code, label] of Object.entries(OCR_REASON_LABELS)) {
    assert.equal(ocrReasonLabel(code), label, code);
    assert.ok(label.length > 0 && label.length <= 80, `${code} stays short`);
    assert.doesNotMatch(label, /[\\/]/, `${code} has no separator`);
    assert.doesNotMatch(label, /volyx-lens-vision-ocr|native-bin|Users|private\/var/, `${code} names no helper or path`);
  }
  // Unknown and prototype-shaped input gets the neutral fallback instead of
  // leaking whatever was passed in.
  assert.equal(ocrReasonLabel('__proto__'), OCR_REASON_FALLBACK);
  assert.equal(ocrReasonLabel('/Users/someone/helper'), OCR_REASON_FALLBACK);
  assert.equal(ocrReasonLabel(undefined), OCR_REASON_FALLBACK);
  assert.equal(ocrReasonLabel({ reason: 'helper_missing' }), OCR_REASON_FALLBACK);

  // The availability path that main actually reads feeds the same mapping.
  const runner = createLocalOcr({ platform: 'linux', helperPath: '/missing' });
  const availability = runner.availability();
  assert.equal(availability.available, false);
  assert.equal(ocrReasonLabel(availability.reason), 'not available on this platform');
});
