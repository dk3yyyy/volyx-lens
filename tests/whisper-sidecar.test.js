'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WhisperSidecar } = require('../src/whisper-sidecar');

test('WhisperSidecar constructs without throwing and starts not running', () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  assert.equal(sidecar.running, false);
  assert.equal(sidecar.modelId, 'tiny');
});

test('the running accessor tracks state without recursion', () => {
  const states = [];
  const sidecar = new WhisperSidecar({ modelId: 'tiny', onstate: (state) => states.push(state) });
  sidecar._setState('ready');
  assert.equal(sidecar.running, 'ready');
  assert.deepEqual(states, ['ready']);
  sidecar._setState('idle');
  assert.equal(sidecar.running, 'idle');
  assert.deepEqual(states, ['ready', 'idle']);
});
