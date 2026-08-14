'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WhisperSidecar } = require('../src/whisper-sidecar');

test('WhisperSidecar constructs without throwing and starts not running', () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  assert.equal(sidecar.running, false);
  assert.equal(sidecar.state, null);
  assert.equal(sidecar.modelId, 'tiny');
});

test('running is a boolean derived from state; idle leaves it restartable', () => {
  const states = [];
  const sidecar = new WhisperSidecar({ modelId: 'tiny', onstate: (state) => states.push(state) });
  sidecar._setState('starting');
  assert.equal(sidecar.state, 'starting');
  assert.equal(sidecar.running, true);
  sidecar._setState('ready');
  assert.equal(sidecar.state, 'ready');
  assert.equal(sidecar.running, true);
  assert.deepEqual(states, ['starting', 'ready']);
  sidecar._setState('idle');
  assert.equal(sidecar.state, 'idle');
  assert.equal(sidecar.running, false, 'idle must allow a later start()');
});

test('queueYou and queueThem resolve with the transcript produced by _transcribe', async () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  sidecar._transcribe = async (pcm, channel) => `${channel}:${pcm.length}`;
  const you = await sidecar.queueYou(Buffer.from('hello you'));
  const them = await sidecar.queueThem(Buffer.from('hello them'));
  assert.equal(you.text, 'you:9');
  assert.equal(you.channel, 'you');
  assert.equal(typeof you.timestamp, 'number');
  assert.equal(them.text, 'them:10');
  assert.equal(them.channel, 'them');
});

test('queueYou rejects and the queue continues when _transcribe fails', async () => {
  const sidecar = new WhisperSidecar({ modelId: 'tiny' });
  let calls = 0;
  sidecar._transcribe = async () => {
    calls += 1;
    if (calls === 1) throw new Error('transcribe failed');
    return 'recovered';
  };
  const first = sidecar.queueYou(Buffer.from('a'));
  const second = sidecar.queueYou(Buffer.from('b'));
  await assert.rejects(first, /transcribe failed/);
  const recovered = await second;
  assert.equal(recovered.text, 'recovered');
  assert.equal(recovered.channel, 'you');
});
