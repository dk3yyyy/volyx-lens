'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSTT, resolveTranscriptionMode } = require('../src/stt');

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

test('offline-first routes every GGUF model to local batch instead of cloud realtime', () => {
  for (const localModelId of ['qwen3-asr-0.6b', 'parakeet-unified-en', 'nemotron-3.5-asr-streaming-0.6b']) {
    assert.equal(resolveTranscriptionMode({
      apiKeys: { openai: 'sk-test' },
      transcription: { mode: 'realtime', offlineEnabled: true, offlineCloudFallback: false, localModelId },
      speechModels: [{ id: localModelId, installed: true }],
    }, { speechWorkerAvailable: true, hasAudioChannels: true }), 'batch');
  }
});

test('cloud realtime remains the default when offline-first is disabled', () => {
  assert.equal(resolveTranscriptionMode({
    transcription: { offlineEnabled: false, localModelId: 'qwen3-asr-0.6b' },
  }, { speechWorkerAvailable: true, hasAudioChannels: true }), 'realtime');
});

test('offline-first falls back to local batch when the native worker is unavailable', () => {
  assert.equal(resolveTranscriptionMode({
    transcription: { offlineEnabled: true, localModelId: 'qwen3-asr-0.6b' },
    speechModels: [{ id: 'qwen3-asr-0.6b', installed: true }],
  }, { speechWorkerAvailable: false, hasAudioChannels: true }), 'batch');
});

test('offline-first without an installed model leaves realtime in charge', () => {
  const settings = {
    apiKeys: { openai: 'sk-test' },
    transcription: { mode: 'realtime', offlineEnabled: true, localModelId: 'qwen3-asr-0.6b' },
    speechModels: [{ id: 'qwen3-asr-0.6b', installed: false }],
  };
  assert.equal(resolveTranscriptionMode(settings, { speechWorkerAvailable: true, hasAudioChannels: true }), 'realtime');
  assert.equal(resolveTranscriptionMode({ ...settings, speechModels: [] }, {}), 'realtime');
});

test('offline-first keeps legacy Whisper on the local batch path', () => {
  assert.equal(resolveTranscriptionMode({
    transcription: { offlineEnabled: true, whisperModel: 'base.en' },
  }, { speechWorkerAvailable: true, hasAudioChannels: true }), 'batch');
});

test('offline-first tries a local model before enabled cloud fallback', () => {
  assert.equal(resolveTranscriptionMode({
    transcription: {
      offlineEnabled: true,
      offlineCloudFallback: true,
      localModelId: 'qwen3-asr-0.6b',
    },
    speechModels: [{ id: 'qwen3-asr-0.6b', installed: true }],
  }, { speechWorkerAvailable: true, hasAudioChannels: true }), 'batch');
});

test('STT factory routes selected GGUF models through the batch worker with backend and language', async () => {
  const calls = [];
  const stt = createSTT({
    apiKeys: {},
    transcription: {
      mode: 'realtime',
      offlineEnabled: true,
      offlineCloudFallback: false,
      localModelId: 'qwen3-asr-0.6b',
      speechBackend: 'gpu',
      language: 'fr',
    },
  }, {
    env: {},
    speechWorker: {
      transcribe: async (request) => {
        calls.push(request);
        return { text: 'Bonjour', segments: [], backend: 'mtl0' };
      },
    },
  });
  assert.deepEqual(stt.providers, ['local-gguf']);
  const result = await stt.transcribe(Buffer.alloc(4000, 1));
  assert.equal(result.text, 'Bonjour');
  assert.equal(result.provider, 'local-gguf');
  assert.equal(result.modelId, 'qwen3-asr-0.6b');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].modelId, 'qwen3-asr-0.6b');
  assert.equal(calls[0].language, 'fr');
  assert.equal(calls[0].backend, 'gpu');
  assert.equal(calls[0].wav.subarray(0, 4).toString('ascii'), 'RIFF');
});

test('STT factory keeps cloud fallback after a failed local GGUF batch only when explicitly enabled', async () => {
  const settings = {
    apiKeys: { openai: 'sk-test' },
    transcription: {
      mode: 'realtime',
      offlineEnabled: true,
      offlineCloudFallback: true,
      localModelId: 'qwen3-asr-0.6b',
    },
  };
  const stt = createSTT(settings, {
    env: {},
    speechWorker: { transcribe: async () => { throw new Error('local failed'); } },
    openAITranscribe: async () => 'cloud fallback',
  });
  assert.deepEqual(stt.providers, ['local-gguf', 'openai']);
  const result = await stt.transcribe(Buffer.alloc(4000, 1));
  assert.deepEqual(result, { text: 'cloud fallback', provider: 'openai' });
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
