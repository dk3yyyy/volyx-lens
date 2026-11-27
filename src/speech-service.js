'use strict';

const { getModel, listModels, isInstalled, prepareModel, removeModel } = require('./speech-model-registry');
const { resolveSpeechWorkerBinary } = require('./speech-worker');

// Stable application-facing seam for local speech inference. Runtime-specific
// adapters stay behind this boundary while the registry owns model artifacts.
function createSpeechService({ transcribe, warm, unload, now = () => Date.now() } = {}) {
  if (typeof transcribe !== 'function') throw new TypeError('A local transcription adapter is required.');
  let active = 0;
  let lastError = null;

  return {
    listModels() {
      const runtimeAvailable = resolveSpeechWorkerBinary().available;
      return listModels().map((model) => ({
        ...model,
        runtimeAvailable: model.runtime === 'transcribe-cpp' ? runtimeAvailable : model.runtimeAvailable,
      }));
    },
    getModelStatus(id) {
      const model = getModel(id);
      if (!model) return { id: String(id || ''), available: false, state: 'unsupported', activeJobs: active, lastError: null };
      const installed = isInstalled(model.id);
      const runtimeAvailable = model.runtime !== 'transcribe-cpp' || resolveSpeechWorkerBinary().available;
      return {
        id: model.id,
        available: runtimeAvailable,
        runtimeAvailable,
        installed,
        state: active ? 'transcribing' : (!runtimeAvailable ? 'runtime-unavailable' : (installed ? 'installed' : 'not-installed')),
        activeJobs: active,
        lastError,
      };
    },
    prepareModel(id, onProgress, options) { return prepareModel(id, onProgress, options); },
    removeModel(id) { return removeModel(id); },
    async warmModel(id) {
      const model = getModel(id);
      if (!model || model.runtime !== 'transcribe-cpp' || typeof warm !== 'function') {
        const error = new Error(`Local warm-up is unavailable for model: ${String(id || '')}`);
        error.code = 'speech_model_warmup_unavailable';
        throw error;
      }
      return warm(model.id);
    },
    async unloadModel(id) {
      const model = getModel(id);
      if (!model || model.runtime !== 'transcribe-cpp' || typeof unload !== 'function') {
        const error = new Error(`Local unload is unavailable for model: ${String(id || '')}`);
        error.code = 'speech_model_unload_unavailable';
        throw error;
      }
      return unload(model.id);
    },
    async transcribe({ wav, modelId, language = '' } = {}) {
      const model = getModel(modelId);
      if (!model) {
        const error = new Error(`Unsupported local speech model: ${String(modelId || '')}`);
        error.code = 'speech_model_unsupported';
        throw error;
      }
      const startedAt = now();
      active += 1;
      lastError = null;
      try {
        const result = await transcribe({ wav, modelId: model.id, language });
        return {
          text: String(result && typeof result === 'object' ? result.text || '' : result || '').trim(),
          provider: model.runtime === 'transcribe-cpp' ? 'local-gguf' : 'local-whisper',
          modelId: model.id,
          startedAt,
          completedAt: now(),
        };
      } catch (error) {
        lastError = { code: error && error.code || 'speech_inference_failed', message: String(error && error.message || error).slice(0, 240) };
        throw error;
      } finally {
        active = Math.max(0, active - 1);
      }
    },
  };
}

module.exports = { createSpeechService };
