'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createSpeechModelArtifactStore } = require('../src/speech-model-artifact-store');
const { listModels, isInstalled } = require('../src/speech-model-registry');

const bytes = Buffer.from('local model');
const revision = '0123456789abcdef0123456789abcdef01234567';
const model = {
  id: 'test-model',
  artifact: {
    repository: 'test-owner/test-model',
    revision,
    filename: 'model.gguf',
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  },
};

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-length': String(data.length) }),
    body: Readable.from([data]),
  };
}

function makeTempStore(fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-speech-models-'));
  const store = createSpeechModelArtifactStore({ root, fetchImpl });
  return {
    root,
    store,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('pinned model artifacts download atomically, verify their digest, and detect later corruption', async (t) => {
  let downloads = 0;
  const fixture = makeTempStore(async (url) => {
    downloads += 1;
    assert.equal(url, `https://huggingface.co/test-owner/test-model/resolve/${revision}/model.gguf`);
    return response(bytes);
  });
  t.after(fixture.cleanup);
  const progress = [];

  const installed = await fixture.store.prepareModel(model, (value) => progress.push(value));

  assert.equal(installed.modelId, model.id);
  assert.equal(installed.revision, revision);
  assert.equal(installed.sha256, model.artifact.sha256);
  assert.equal(fs.readFileSync(installed.path).toString(), bytes.toString());
  assert.equal(fixture.store.isInstalled(model), true);
  assert.equal(await fixture.store.verifyModel(model), true);
  assert.deepEqual(progress, [1]);

  fs.writeFileSync(installed.path, Buffer.from('TAMPERED!!!'));
  assert.equal(fixture.store.isInstalled(model), true, 'status reads the verified receipt; preparation re-hashes the weights');
  assert.equal(await fixture.store.verifyModel(model), false, 'inference verifies the full model digest before loading');
  await fixture.store.prepareModel(model);
  assert.equal(downloads, 2);
  assert.equal(fs.readFileSync(installed.path).toString(), bytes.toString());
});

test('removing a model clears all locally stored revisions for that model', async (t) => {
  const fixture = makeTempStore(async () => response(bytes));
  t.after(fixture.cleanup);
  const installed = await fixture.store.prepareModel(model);
  const olderRevision = path.join(fixture.root, model.id, 'fedcba9876543210fedcba9876543210fedcba98');
  fs.mkdirSync(olderRevision, { recursive: true });
  fs.writeFileSync(path.join(olderRevision, 'old-model.gguf'), Buffer.from('old'));

  await fixture.store.removeModel(model);

  assert.equal(fs.existsSync(installed.path), false);
  assert.equal(fs.existsSync(path.join(fixture.root, model.id)), false);
});

test('artifact digest or size mismatches fail without leaving a partial installation', async (t) => {
  const fixture = makeTempStore(async () => response(Buffer.from('corrupt data')));
  t.after(fixture.cleanup);

  await assert.rejects(fixture.store.prepareModel(model), /exceeded its pinned size|size mismatch|SHA-256/);
  assert.equal(fixture.store.isInstalled(model), false);
  assert.equal(fs.existsSync(fixture.store.paths(model).partialPath), false);
});

test('a receipt without its artifact file is not reported as installed', async (t) => {
  const fixture = makeTempStore(async () => response(bytes));
  t.after(fixture.cleanup);
  const installed = await fixture.store.prepareModel(model);
  assert.equal(fixture.store.isInstalled(model), true);

  fs.rmSync(installed.path);

  assert.equal(fs.existsSync(fixture.store.paths(model).receiptPath), true, 'the receipt alone still exists');
  assert.equal(fixture.store.isInstalled(model), false, 'a receipt cannot vouch for a missing artifact');
  assert.equal(await fixture.store.verifyModel(model), false);
});

test('a receipt with a wrong-size artifact file is not reported as installed', async (t) => {
  const fixture = makeTempStore(async () => response(bytes));
  t.after(fixture.cleanup);
  const installed = await fixture.store.prepareModel(model);
  assert.equal(fixture.store.isInstalled(model), true);

  fs.writeFileSync(installed.path, Buffer.alloc(bytes.length + 1, 0x41));

  assert.equal(fixture.store.isInstalled(model), false, 'the pinned byte length is checked before reporting installed');
  assert.equal(await fixture.store.verifyModel(model), false);
});

test('cancellation during final artifact installation removes the installed model', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-speech-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const fsImpl = {
    ...fs,
    promises: {
      ...fs.promises,
      rename: async (from, to) => {
        const result = await fs.promises.rename(from, to);
        if (String(to).endsWith('model.gguf')) controller.abort();
        return result;
      },
    },
  };
  const store = createSpeechModelArtifactStore({ root, fetchImpl: async () => response(bytes), fsImpl });

  await assert.rejects(store.prepareModel(model, undefined, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(store.isInstalled(model), false);
  assert.equal(fs.existsSync(store.paths(model).modelPath), false);
  assert.equal(fs.existsSync(store.paths(model).receiptPath), false);
});

test('registry exports the ASR catalog, detector operations, and artifact operations', () => {
  const registry = require('../src/speech-model-registry');
  assert.deepEqual(Object.keys(registry).sort(), [
    'MODELS', 'MODEL_ARTIFACT_STORE', 'getModel', 'isInstalled', 'isSpeechDetectorInstalled',
    'isSpeechDiarizerInstalled', 'listModels', 'modelPaths', 'prepareModel', 'prepareSpeechDetector',
    'prepareSpeechDiarizer', 'removeModel', 'removeSpeechDetector', 'removeSpeechDiarizer',
    'speechDetectorInfo', 'speechDetectorPaths', 'speechDiarizerInfo', 'speechDiarizerPaths',
    'verifyModel', 'verifySpeechDetector', 'verifySpeechDiarizer',
  ]);
  const streaming = listModels().filter((model) => model.streaming === true).map((model) => model.id).sort();
  assert.deepEqual(streaming, ['nemotron-3.5-asr-streaming-0.6b', 'parakeet-unified-en']);
});

test('every registered GGUF model can be checked for installation without throwing', () => {
  for (const model of listModels().filter((entry) => entry.runtime === 'transcribe-cpp')) {
    assert.doesNotThrow(() => isInstalled(model.id), model.id);
  }
});

test('catalog exposes the requested models as version-pinned registry entries', () => {
  const models = listModels();
  const requested = [
    'parakeet-unified-en',
    'whisper-large-v3-turbo',
    'qwen3-asr-0.6b',
    'cohere-transcribe-03-2026',
    'sensevoice-small',
    'nemotron-3.5-asr-streaming-0.6b',
  ];

  for (const id of requested) {
    const modelEntry = models.find((entry) => entry.id === id);
    assert.ok(modelEntry, `missing registry entry: ${id}`);
    assert.equal(modelEntry.runtime, 'transcribe-cpp');
    assert.match(modelEntry.artifact.revision, /^[a-f0-9]{40}$/);
    assert.match(modelEntry.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(modelEntry.artifact.bytes > 0);
    assert.equal(modelEntry.artifact.format, 'gguf');
    if (id === 'sensevoice-small') {
      assert.equal(modelEntry.artifact.sha256, '6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29');
    }
  }
});
