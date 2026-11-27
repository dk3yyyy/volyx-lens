'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSpeechOperationGate } = require('../src/speech-operation-gate');
const main = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('speech operation gate serializes access and rejects overlapping work', async () => {
  const gate = createSpeechOperationGate();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });

  const first = gate.run('warm', async () => {
    assert.equal(gate.isBusy(), true);
    await pending;
    return 'warmed';
  });

  assert.equal(gate.isBusy(), true);
  await assert.rejects(gate.run('remove', async () => 'removed'), {
    code: 'speech_model_operation_in_progress',
  });

  release();
  assert.equal(await first, 'warmed');
  assert.equal(gate.isBusy(), false);
  assert.equal(await gate.run('unload', async () => 'unloaded'), 'unloaded');
});

test('main serializes model operations and makes capture wait for them', () => {
  assert.match(main, /createSpeechOperationGate\(\)/);
  assert.match(main, /speechOperationGate\.whenIdle\(\)/);
  assert.match(main, /speechOperationGate\.isBusy\(\)/);
  for (const channel of ['download', 'remove', 'warm', 'unload']) {
    const start = main.indexOf(`handleTrusted('speech-model:${channel}'`);
    const block = main.slice(start, main.indexOf('\n});', start) + 4);
    assert.match(block, /speechOperationGate\.run\(/, channel);
  }
});

test('speech operation gate lets capture wait for an active model operation', async () => {
  const gate = createSpeechOperationGate();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const operation = gate.run('download', async () => {
    await pending;
    return 'downloaded';
  });

  let captureResumed = false;
  const waiting = gate.whenIdle().then(() => { captureResumed = true; });
  await Promise.resolve();
  assert.equal(captureResumed, false);

  release();
  await operation;
  await waiting;
  assert.equal(captureResumed, true);
});
