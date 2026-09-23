'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSTT } = require('../src/stt');

test('STT factory builds chain with OpenAI provider when key present', () => {
  const settings = {
    apiKeys: { openai: 'sk-test' },
    transcription: { mode: 'batch', offlineEnabled: false, offlineCloudFallback: false },
  };
  const stt = createSTT(settings);
  assert.ok(stt.available);
  assert.ok(stt.providers.includes('openai'));
});

test('STT factory builds chain with Groq provider when key present', () => {
  const settings = {
    apiKeys: { groq: 'gsk-test' },
    transcription: { mode: 'batch', offlineEnabled: false, offlineCloudFallback: false },
  };
  const stt = createSTT(settings);
  assert.ok(stt.available);
  assert.ok(stt.providers.includes('groq'));
});

test('STT factory builds chain with both OpenAI and Groq when both keys present', () => {
  const settings = {
    apiKeys: { openai: 'sk-test', groq: 'gsk-test' },
    transcription: { mode: 'batch', offlineEnabled: false, offlineCloudFallback: false },
  };
  const stt = createSTT(settings);
  assert.ok(stt.available);
  assert.ok(stt.providers.includes('openai'));
  assert.ok(stt.providers.includes('groq'));
});

test('STT factory skips Groq when offline mode is enabled without cloud fallback', () => {
  const settings = {
    apiKeys: { groq: 'gsk-test' },
    transcription: { mode: 'batch', offlineEnabled: true, offlineCloudFallback: false },
  };
  const stt = createSTT(settings);
  assert.ok(!stt.providers.includes('groq'));
});

test('STT factory includes Groq when offline mode has cloud fallback enabled', () => {
  const settings = {
    apiKeys: { groq: 'gsk-test' },
    transcription: { mode: 'batch', offlineEnabled: true, offlineCloudFallback: true },
  };
  const stt = createSTT(settings);
  assert.ok(stt.providers.includes('groq'));
});

test('STT factory returns empty chain when no keys present', () => {
  const settings = {
    apiKeys: {},
    transcription: { mode: 'batch', offlineEnabled: false, offlineCloudFallback: false },
  };
  const stt = createSTT(settings);
  assert.ok(!stt.available);
  assert.equal(stt.providers.length, 0);
});
