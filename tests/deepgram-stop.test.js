'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DeepgramRealtimeChannel } = require('../src/deepgram-realtime');

function channel({ opened = false, sendFinalizeThrows = false } = {}) {
  const errors = [];
  const instance = new DeepgramRealtimeChannel({
    apiKey: 'test-key',
    channel: 'you',
    provider: 'deepgram',
    model: 'nova-2',
    language: 'en',
    sampleRate: 16000,
    WebSocketImpl: EventEmitter,
    DeepgramClientImpl: null,
    onPartial: () => {},
    onFinal: () => {},
    onError: (error) => errors.push(error),
    onState: () => {},
    onLatency: () => {},
  });
  const connection = {
    sendFinalize: () => { if (sendFinalizeThrows) throw new Error('socket is not open'); },
    send: () => {},
    close: () => {},
  };
  instance.connection = connection;
  instance.opened = opened;
  return { instance, errors };
}

test('stopping while the socket is still connecting does not raise a fatal error', () => {
  const { instance, errors } = channel({ opened: false, sendFinalizeThrows: true });
  instance.beginStop();
  instance.commit();
  assert.equal(errors.length, 0, 'nothing to finalise means nothing to report');
});

test('a stop on an open socket still finalises the last utterance', () => {
  let finalized = 0;
  const { instance } = channel({ opened: true });
  instance.connection.sendFinalize = () => { finalized += 1; };
  instance.beginStop();
  instance.commit();
  assert.equal(finalized, 1, 'the final transcript is still requested');
});

test('a send failure during a requested stop is not reported as a meeting failure', () => {
  const { instance, errors } = channel({ opened: true, sendFinalizeThrows: true });
  instance.beginStop();
  instance.commit();
  assert.equal(errors.length, 0, 'the user asked to stop, so this is not a fault');
});

test('a send failure outside a stop is still reported', () => {
  const { instance, errors } = channel({ opened: true, sendFinalizeThrows: true });
  instance.commit();
  assert.equal(errors.length, 1, 'a genuine failure during the meeting must reach the user');
});

test('commit before the socket opens is a no-op even without a stop', () => {
  const { instance, errors } = channel({ opened: false, sendFinalizeThrows: true });
  instance.commit();
  assert.equal(errors.length, 0);
});

test('the session marks the channel before it finalises on stop', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'realtime-stt.js'), 'utf8');
  const stopBody = source.slice(source.indexOf('  stop({ graceMs'), source.indexOf('  stop({ graceMs') + 1400);
  const mark = stopBody.indexOf('beginStop');
  const commit = stopBody.indexOf('.commit()');
  assert.ok(mark !== -1, 'the stop path marks the channel');
  assert.ok(mark < commit, 'and marks it before the finalize, not after');
});
