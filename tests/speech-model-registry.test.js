'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MODELS, getModel, listModels } = require('../src/speech-model-registry');

const ULTRA = Object.freeze({
  id: 'parakeet-ultra',
  name: 'Parakeet Ultra',
  family: 'parakeet',
  version: 'ultra-tdt-0.6b-q8_0',
  repository: 'handy-computer/parakeet-ultra-gguf',
  revision: 'a1539be1b849ea7463b88343e5277b373d0c4ea9',
  filename: 'parakeet-ultra-Q8_0.gguf',
  bytes: 740363168,
  sha256: '007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59',
  url: 'https://huggingface.co/handy-computer/parakeet-ultra-gguf/resolve/a1539be1b849ea7463b88343e5277b373d0c4ea9/parakeet-ultra-Q8_0.gguf',
});

// Parakeet v3's 25 languages, copied from Hex's PARAKEET_V3_LANGUAGES.
const PARAKEET_LANGUAGES = Object.freeze([
  'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt',
  'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'es', 'sv', 'uk',
]);

test('Parakeet Ultra is a registered transcribe.cpp batch model', () => {
  const model = getModel(ULTRA.id);
  assert.ok(model, 'missing registry entry: parakeet-ultra');
  assert.equal(model.id, ULTRA.id);
  assert.equal(model.name, ULTRA.name);
  assert.equal(model.family, ULTRA.family);
  assert.equal(model.version, ULTRA.version);
  assert.equal(model.runtime, 'transcribe-cpp');
  assert.equal(model.streaming, false);
  assert.equal(model.languageDetection, true);
  assert.deepEqual(model.languages, [...PARAKEET_LANGUAGES]);
  assert.equal(model.license.name, 'NVIDIA Open Model License');
});

test('Parakeet Ultra pins the Hex artifact exactly', () => {
  const { artifact } = getModel(ULTRA.id);
  assert.equal(artifact.format, 'gguf');
  assert.equal(artifact.filename, ULTRA.filename);
  assert.equal(artifact.repository, ULTRA.repository);
  assert.equal(artifact.revision, ULTRA.revision);
  assert.equal(artifact.bytes, ULTRA.bytes);
  assert.equal(artifact.sha256, ULTRA.sha256);
});

test('Parakeet Ultra download URL and size estimates follow the catalog method', () => {
  const model = getModel(ULTRA.id);
  assert.equal(model.artifact.url, ULTRA.url);
  assert.equal(
    model.artifact.estimatedSizeMb,
    Math.ceil(ULTRA.bytes / (1024 * 1024)),
  );
  assert.equal(
    model.hardware.estimatedMemoryMb,
    Math.ceil((ULTRA.bytes / (1024 * 1024)) * 1.6),
  );
});

test('Parakeet Ultra does not displace the default streaming model', () => {
  const defaultStreaming = MODELS.find((model) => model.streaming === true);
  assert.equal(defaultStreaming.id, 'parakeet-unified-en');
  assert.equal(getModel('parakeet-unified-en').streaming, true);
  assert.notEqual(getModel(ULTRA.id).id, defaultStreaming.id);
  assert.equal(listModels().filter((model) => model.id === ULTRA.id).length, 1);
});
