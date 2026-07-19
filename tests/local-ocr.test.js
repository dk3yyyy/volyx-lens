const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  MAX_STDOUT_BYTES,
  decodeImageDataUrl,
  validateVisionHelper,
  runVisionHelper,
  createLocalOcr,
} = require('../src/local-ocr');

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
  assert.equal(validateVisionHelper(process.execPath, 'linux').ready, false);
  assert.equal(validateVisionHelper(process.execPath, 'darwin').ready, true);
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
    helperPath: process.execPath,
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

test('cancelAll resolves queued OCR immediately and prevents it from spawning', async () => {
  const children = [];
  const runner = createLocalOcr({
    platform: 'darwin',
    helperPath: process.execPath,
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
