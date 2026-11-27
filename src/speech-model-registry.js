'use strict';

const { MODEL_SPECS, MODELS_DIR, downloadModel } = require('./whisper-sidecar');
const { fileFor, downloadUrl } = require('./whisper-models');
const { createSpeechModelArtifactStore } = require('./speech-model-artifact-store');
const fs = require('node:fs');
const path = require('node:path');

const MODEL_ARTIFACT_STORE = createSpeechModelArtifactStore();
const SPEECH_DETECTOR = Object.freeze({
  id: 'silero-vad-v6.2',
  name: 'Silero VAD v6.2',
  runtime: 'transcribe-cpp-vad',
  artifact: Object.freeze({
    format: 'gguf',
    filename: 'silero-vad-v6.2-F32.gguf',
    repository: 'handy-computer/silero-vad-v6.2-gguf',
    revision: 'a9b2d61c20ae4ddf3644edb34969e8185a485448',
    bytes: 1241056,
    sha256: '0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6',
  }),
  license: Object.freeze({ name: 'MIT', url: 'https://github.com/snakers4/silero-vad' }),
});
const SPEECH_DIARIZER = Object.freeze({
  id: 'diar-sortformer-4spk',
  name: 'Sortformer 4-speaker diarizer',
  runtime: 'transcribe-cpp-diarize',
  sampleRate: 16000,
  maxSpeakers: 4,
  presets: Object.freeze(['low_latency', 'high_latency', 'very_high_latency']),
  artifact: Object.freeze({
    format: 'gguf',
    filename: 'diar_streaming_sortformer_4spk-v2.1-Q8_0.gguf',
    repository: 'handy-computer/diar_streaming_sortformer_4spk-v2.1-gguf',
    revision: '60ebab3ef7cae9869be0abcde13360347e96ba03',
    bytes: 139310336,
    sha256: 'a5dacdc650790266c7a362e54e6bf51952015487edaa606c4e11632bc32442a9',
  }),
  license: Object.freeze({ name: 'NVIDIA Open Model License', url: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' }),
});
const TRANSCRIBE_CPP_MODELS = [
  {
    id: 'parakeet-unified-en',
    name: 'Parakeet Unified English',
    family: 'parakeet',
    version: 'unified-en-0.6b-q8_0',
    languages: ['en'],
    languageCoverage: 'English',
    languageDetection: false,
    streaming: true,
    license: { name: 'NVIDIA Open Model License', url: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
    artifact: {
      format: 'gguf',
      filename: 'parakeet-unified-en-0.6b-Q8_0.gguf',
      repository: 'handy-computer/parakeet-unified-en-0.6b-gguf',
      revision: '7e948f21b7bdbac698d3318db9d350f1096f3b6c',
      bytes: 731357568,
      sha256: '4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795',
    },
  },
  {
    id: 'parakeet-ultra',
    name: 'Parakeet Ultra',
    family: 'parakeet',
    version: 'ultra-tdt-0.6b-q8_0',
    languages: ['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'es', 'sv', 'uk'],
    languageCoverage: '25 languages',
    languageDetection: true,
    streaming: false,
    license: { name: 'NVIDIA Open Model License', url: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/' },
    artifact: {
      format: 'gguf',
      filename: 'parakeet-ultra-Q8_0.gguf',
      repository: 'handy-computer/parakeet-ultra-gguf',
      revision: 'a1539be1b849ea7463b88343e5277b373d0c4ea9',
      bytes: 740363168,
      sha256: '007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59',
    },
  },
  {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper large-v3-turbo',
    family: 'whisper',
    version: 'large-v3-turbo-q8_0',
    languages: [],
    languageCoverage: 'Multilingual',
    languageDetection: true,
    streaming: false,
    license: { name: 'MIT', url: 'https://huggingface.co/handy-computer/whisper-large-v3-turbo-gguf' },
    artifact: {
      format: 'gguf',
      filename: 'whisper-large-v3-turbo-Q8_0.gguf',
      repository: 'handy-computer/whisper-large-v3-turbo-gguf',
      revision: 'd222c9f621c1128299248f2ded4d8a1820519780',
      bytes: 886381824,
      sha256: 'd5e65f2b0828802ae2c231673d31982cebe3a778c95d9494a9f3efee6bd17448',
    },
  },
  {
    id: 'qwen3-asr-0.6b',
    name: 'Qwen3-ASR 0.6B',
    family: 'qwen3-asr',
    version: '0.6b-q8_0',
    languages: ['zh', 'en', 'yue', 'ar', 'de', 'fr', 'es', 'pt', 'id', 'it', 'ko', 'ru', 'th', 'vi', 'ja', 'tr', 'hi', 'ms', 'nl', 'sv', 'da', 'fi', 'pl', 'cs', 'fil', 'fa', 'el', 'ro', 'hu', 'mk'],
    languageCoverage: '30 languages',
    languageDetection: true,
    streaming: false,
    license: { name: 'Apache-2.0', url: 'https://huggingface.co/handy-computer/Qwen3-ASR-0.6B-gguf' },
    artifact: {
      format: 'gguf',
      filename: 'Qwen3-ASR-0.6B-Q8_0.gguf',
      repository: 'handy-computer/Qwen3-ASR-0.6B-gguf',
      revision: 'e4e16599b900eb0cb36e524514756bb92eb092b7',
      bytes: 850423456,
      sha256: 'f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8',
    },
  },
  {
    id: 'cohere-transcribe-03-2026',
    name: 'Cohere Transcribe 03-2026',
    family: 'cohere-asr',
    version: '03-2026-q8_0',
    languages: ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'el', 'ar', 'ja', 'zh', 'vi', 'ko'],
    languageCoverage: '14 languages',
    languageDetection: true,
    streaming: false,
    license: { name: 'Apache-2.0', url: 'https://huggingface.co/handy-computer/cohere-transcribe-03-2026-gguf' },
    artifact: {
      format: 'gguf',
      filename: 'cohere-transcribe-03-2026-Q8_0.gguf',
      repository: 'handy-computer/cohere-transcribe-03-2026-gguf',
      revision: 'dfa4adebb64f3076b7b6b90b721275cc069cb421',
      bytes: 2410655232,
      sha256: '931916663432fd895423a4291a8400221802b288967ca2d435fc5e3141c9e71e',
    },
  },
  {
    id: 'sensevoice-small',
    name: 'SenseVoiceSmall',
    family: 'sensevoice',
    version: 'small-q8_0',
    languages: ['zh', 'en', 'yue', 'ja', 'ko'],
    languageCoverage: 'Chinese, English, Cantonese, Japanese, Korean',
    languageDetection: true,
    streaming: false,
    license: { name: 'FunASR MODEL_LICENSE', url: 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE' },
    artifact: {
      format: 'gguf',
      filename: 'SenseVoiceSmall-Q8_0.gguf',
      repository: 'handy-computer/SenseVoiceSmall-gguf',
      revision: '4a08b8e900b38a977e32eb08d5d0697d6e72ba04',
      bytes: 252684608,
      sha256: '6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29',
    },
  },
  {
    id: 'nemotron-3.5-asr-streaming-0.6b',
    name: 'Nemotron 3.5 ASR Streaming 0.6B',
    family: 'nemotron-asr',
    version: '3.5-streaming-0.6b-q8_0',
    languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'tr', 'ru', 'uk', 'pl', 'cs', 'sk', 'bg', 'hr', 'ro', 'hu', 'sv', 'da', 'fi', 'et', 'ar', 'hi', 'ja', 'ko', 'zh', 'vi'],
    languageCoverage: '27 languages',
    languageDetection: false,
    streaming: true,
    license: { name: 'OpenMDW-1.1', url: 'https://openmdw.ai/license/1-1/' },
    artifact: {
      format: 'gguf',
      filename: 'nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf',
      repository: 'handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf',
      revision: '53ce288f69326b415aeef030cfcb02a08a8096dd',
      bytes: 751094240,
      sha256: 'b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c',
    },
  },
].map((definition) => {
  const artifact = Object.freeze({ ...definition.artifact });
  return Object.freeze({
    ...definition,
    runtime: 'transcribe-cpp',
    runtimeAvailable: false,
    languages: Object.freeze([...definition.languages]),
    vocabulary: Object.freeze({ supported: false, method: 'none' }),
    artifact: Object.freeze({
      ...artifact,
      estimatedSizeMb: Math.ceil(artifact.bytes / (1024 * 1024)),
      url: `https://huggingface.co/${artifact.repository}/resolve/${artifact.revision}/${encodeURIComponent(artifact.filename)}`,
    }),
    hardware: Object.freeze({
      cpu: true,
      gpu: 'Metal when available',
      estimatedMemoryMb: Math.ceil((artifact.bytes / (1024 * 1024)) * 1.6),
      memoryEstimateBasis: 'rough quantized-model estimate; measured runtime usage can vary by model and device',
    }),
  });
});

const WHISPER_MODELS = Object.freeze(Object.entries(MODEL_SPECS).map(([id, spec]) => Object.freeze({
  id,
  name: `Whisper ${id}`,
  family: 'whisper',
  version: 'whisper.cpp-compatible',
  runtime: 'whisper.cpp-server',
  runtimeAvailable: true,
  languages: Object.freeze(id.endsWith('.en') ? ['en'] : []),
  languageCoverage: id.endsWith('.en') ? 'English only' : 'Whisper multilingual set',
  languageDetection: !id.endsWith('.en'),
  streaming: false,
  vocabulary: Object.freeze({ supported: false, method: 'none' }),
  artifact: Object.freeze({
    format: 'ggml-bin',
    estimatedSizeMb: spec.sizeMB,
    ...(fileFor(id) ? { bytes: fileFor(id).bytes, sha256: fileFor(id).sha256, url: downloadUrl(id) } : {}),
  }),
  hardware: Object.freeze({
    cpu: true,
    gpu: 'runtime-dependent',
    estimatedMemoryMb: Math.ceil(spec.sizeMB * 2),
    memoryEstimateBasis: 'rough model-file-size multiplier; benchmark per runtime before recommending',
  }),
  licenseReviewRequired: true,
})));

const MODELS = Object.freeze([...WHISPER_MODELS, ...TRANSCRIBE_CPP_MODELS]);
const BY_ID = new Map(MODELS.map((model) => [model.id, model]));

function getModel(id) {
  return BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

function modelPaths(id) {
  const model = getModel(id);
  if (!model) return null;
  if (model.runtime === 'transcribe-cpp') {
    const stored = MODEL_ARTIFACT_STORE.paths(model);
    return {
      model: stored.modelPath,
      index: stored.receiptPath,
      partial: stored.partialPath,
    };
  }
  return {
    model: path.join(MODELS_DIR, `${model.id}.bin`),
    index: path.join(MODELS_DIR, `${model.id}.idx`),
    partial: path.join(MODELS_DIR, `${model.id}.bin.part`),
  };
}

function isInstalled(id) {
  const model = getModel(id);
  if (!model) return false;
  if (model.runtime === 'transcribe-cpp') return MODEL_ARTIFACT_STORE.isInstalled(model);
  if (!model.artifact.sha256) return false;
  const paths = modelPaths(model.id);
  try {
    const index = JSON.parse(fs.readFileSync(paths.index, 'utf8'));
    const stat = fs.statSync(paths.model);
    return index.model === model.id && index.sha256 === model.artifact.sha256 && stat.size === model.artifact.bytes;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

async function verifyModel(id) {
  const model = getModel(id);
  if (!model) return false;
  if (model.runtime === 'transcribe-cpp') return MODEL_ARTIFACT_STORE.verifyModel(model);
  return isInstalled(model.id);
}

async function prepareModel(id, onProgress, options = {}) {
  const model = getModel(id);
  if (!model || !model.artifact.sha256) {
    const error = new Error(`Local model is not downloadable: ${String(id || '')}`);
    error.code = 'speech_model_unavailable';
    throw error;
  }
  if (model.runtime === 'transcribe-cpp') return MODEL_ARTIFACT_STORE.prepareModel(model, onProgress, options);
  return downloadModel(model.id, onProgress, options);
}

function removeModel(id) {
  const model = getModel(id);
  if (!model) return false;
  if (model.runtime === 'transcribe-cpp') return MODEL_ARTIFACT_STORE.removeModel(model);
  const paths = modelPaths(model.id);
  for (const file of Object.values(paths)) fs.rmSync(file, { force: true });
  return true;
}

function listModels() {
  return MODELS.map((model) => ({
    ...model,
    languages: [...model.languages],
    vocabulary: { ...model.vocabulary },
    license: model.license ? { ...model.license } : undefined,
    artifact: { ...model.artifact },
    hardware: { ...model.hardware },
  }));
}

function speechDetectorInfo() {
  return { ...SPEECH_DETECTOR, artifact: { ...SPEECH_DETECTOR.artifact }, license: { ...SPEECH_DETECTOR.license } };
}

function speechDetectorPaths() {
  const stored = MODEL_ARTIFACT_STORE.paths(SPEECH_DETECTOR);
  return {
    model: stored.modelPath,
    index: stored.receiptPath,
    partial: stored.partialPath,
  };
}

function isSpeechDetectorInstalled() {
  return MODEL_ARTIFACT_STORE.isInstalled(SPEECH_DETECTOR);
}

function verifySpeechDetector() {
  return MODEL_ARTIFACT_STORE.verifyModel(SPEECH_DETECTOR);
}

function prepareSpeechDetector(onProgress = () => {}, options = {}) {
  return MODEL_ARTIFACT_STORE.prepareModel(SPEECH_DETECTOR, onProgress, options);
}

function removeSpeechDetector() {
  return MODEL_ARTIFACT_STORE.removeModel(SPEECH_DETECTOR);
}

function speechDiarizerInfo() {
  return {
    ...SPEECH_DIARIZER,
    presets: [...SPEECH_DIARIZER.presets],
    artifact: { ...SPEECH_DIARIZER.artifact },
    license: { ...SPEECH_DIARIZER.license },
  };
}

function speechDiarizerPaths() {
  const stored = MODEL_ARTIFACT_STORE.paths(SPEECH_DIARIZER);
  return {
    model: stored.modelPath,
    index: stored.receiptPath,
    partial: stored.partialPath,
  };
}

function isSpeechDiarizerInstalled() {
  return MODEL_ARTIFACT_STORE.isInstalled(SPEECH_DIARIZER);
}

function verifySpeechDiarizer() {
  return MODEL_ARTIFACT_STORE.verifyModel(SPEECH_DIARIZER);
}

function prepareSpeechDiarizer(onProgress = () => {}, options = {}) {
  return MODEL_ARTIFACT_STORE.prepareModel(SPEECH_DIARIZER, onProgress, options);
}

function removeSpeechDiarizer() {
  return MODEL_ARTIFACT_STORE.removeModel(SPEECH_DIARIZER);
}

module.exports = {
  MODELS,
  getModel,
  listModels,
  isInstalled,
  verifyModel,
  prepareModel,
  removeModel,
  modelPaths,
  speechDetectorInfo,
  speechDetectorPaths,
  isSpeechDetectorInstalled,
  verifySpeechDetector,
  prepareSpeechDetector,
  removeSpeechDetector,
  speechDiarizerInfo,
  speechDiarizerPaths,
  isSpeechDiarizerInstalled,
  verifySpeechDiarizer,
  prepareSpeechDiarizer,
  removeSpeechDiarizer,
  MODEL_ARTIFACT_STORE,
};
