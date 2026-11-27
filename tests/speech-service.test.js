'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeechService } = require('../src/speech-service');

test('speech service normalizes GGUF batch results and exposes live model status', async () => {
  let release;
  let observed;
  const service = createSpeechService({
    now: () => 100,
    transcribe: (request) => new Promise((resolve) => {
      observed = request;
      release = () => resolve({ text: '  Hello from local inference.  ', backend: 'cpu' });
    }),
  });

  const pending = service.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'qwen3-asr-0.6b', language: 'fr' });
  assert.deepEqual(observed, { wav: Buffer.from('RIFF-test'), modelId: 'qwen3-asr-0.6b', language: 'fr' });
  const active = service.getModelStatus('qwen3-asr-0.6b');
  assert.equal(active.activeJobs, 1);
  assert.equal(active.state, 'transcribing');

  release();
  assert.deepEqual(await pending, {
    text: 'Hello from local inference.',
    provider: 'local-gguf',
    modelId: 'qwen3-asr-0.6b',
    startedAt: 100,
    completedAt: 100,
  });
  assert.equal(service.getModelStatus('qwen3-asr-0.6b').activeJobs, 0);
});

test('speech service records bounded adapter failures and always releases active jobs', async () => {
  const failure = new Error('x'.repeat(500));
  failure.code = 'speech_inference_failed';
  const service = createSpeechService({
    transcribe: async () => { throw failure; },
  });

  await assert.rejects(service.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'qwen3-asr-0.6b' }), (error) => error === failure);
  const status = service.getModelStatus('qwen3-asr-0.6b');
  assert.equal(status.activeJobs, 0);
  assert.equal(status.lastError.code, 'speech_inference_failed');
  assert.equal(status.lastError.message.length, 240);
});

test('speech service keeps legacy Whisper behind the same adapter boundary', async () => {
  const service = createSpeechService({
    transcribe: async ({ modelId }) => ({ text: 'legacy', modelId }),
  });
  const result = await service.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'base.en' });
  assert.equal(result.provider, 'local-whisper');
  assert.equal(result.modelId, 'base.en');
  await assert.rejects(service.warmModel('base.en'), { code: 'speech_model_warmup_unavailable' });
  await assert.rejects(service.unloadModel('base.en'), { code: 'speech_model_unload_unavailable' });
});

test('speech service rejects unsupported models and delegates GGUF warm/unload operations', async () => {
  const calls = [];
  const service = createSpeechService({
    transcribe: async () => ({ text: '' }),
    warm: async (id) => { calls.push(['warm', id]); return { warmed: true }; },
    unload: async (id) => { calls.push(['unload', id]); return { unloaded: true }; },
  });
  await assert.rejects(service.transcribe({ wav: Buffer.from('RIFF-test'), modelId: 'missing' }), { code: 'speech_model_unsupported' });
  assert.equal(service.getModelStatus('missing').state, 'unsupported');
  assert.deepEqual(await service.warmModel('qwen3-asr-0.6b'), { warmed: true });
  assert.deepEqual(await service.unloadModel('qwen3-asr-0.6b'), { unloaded: true });
  assert.deepEqual(calls, [['warm', 'qwen3-asr-0.6b'], ['unload', 'qwen3-asr-0.6b']]);
});

test('speech service lists the ASR catalog with runtime availability', () => {
  const service = createSpeechService({ transcribe: async () => ({ text: '' }) });
  const models = service.listModels();
  assert.ok(models.length > 0);
  assert.ok(models.every((model) => typeof model.runtimeAvailable === 'boolean'));
  assert.ok(models.some((model) => model.id === 'qwen3-asr-0.6b'));
});
