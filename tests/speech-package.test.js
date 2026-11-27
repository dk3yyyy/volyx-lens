'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const verifier = fs.readFileSync(path.join(root, 'scripts', 'verify-vision-ocr-package.js'), 'utf8');
const nativeWorker = fs.readFileSync(path.join(root, 'native', 'speech-worker', 'src', 'main.rs'), 'utf8');
const packageJson = require('../package.json');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

test('packaged macOS verification includes the streaming speech worker', () => {
  assert.match(verifier, /name: 'volyx-speech-worker'/);
  assert.match(verifier, /engine === 'transcribe-cpp'/);
  assert.match(verifier, /protocol === 1/);
  assert.match(verifier, /streaming === true/);
  assert.match(verifier, /p\.diarization === false/);
  assert.match(nativeWorker, /"streaming": true/);
  assert.match(nativeWorker, /"diarization": false/);
});

test('native speech worker tests and package verification run in desktop CI', () => {
  assert.match(packageJson.scripts['test:speech-native'], /cargo test/);
  assert.match(ci, /npm run test:speech-native/);
  assert.ok((ci.match(/npm run test:speech-native/g) || []).length >= 3);
  assert.match(packageJson.scripts['verify:speech-package'], /verify-speech-worker-package/);
  assert.ok((ci.match(/npm run verify:speech-package/g) || []).length >= 3);
});

test('every desktop build and release workflow verifies the packaged speech worker', () => {
  const workflows = [
    'ci.yml',
    'build-linux-unsigned.yml',
    'build-macos-test.yml',
    'build-macos-unsigned.yml',
    'build-windows-unsigned.yml',
    'release-linux.yml',
    'release-macos.yml',
    'release-windows.yml',
  ];
  for (const workflow of workflows) {
    const source = fs.readFileSync(path.join(root, '.github', 'workflows', workflow), 'utf8');
    assert.match(source, /npm run verify:speech-package/, `${workflow} must verify the speech worker`);
  }
});

test('speech worker package identity and native build hooks are complete', () => {
  const filter = packageJson.build.extraResources[0].filter;
  assert.ok(filter.includes('volyx-speech-worker'));
  assert.ok(filter.includes('volyx-speech-worker.exe'));
  assert.ok(packageJson.build.mac.binaries.includes('Contents/Resources/native/volyx-speech-worker'));
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'build-native.js'), 'utf8'), /buildSpeechWorker\(context\)/);
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'before-pack.js'), 'utf8'), /Promise\.all\(\[buildVision\(context\), buildSpeech\(context\)\]\)/);
  assert.equal(packageJson.scripts['eval:speech'], undefined);
  assert.equal(packageJson.scripts['eval:diarization'], undefined);
});

test('preload exposes only local speech model management methods', () => {
  for (const method of [
    'speechModelsGet', 'speechModelDownload', 'speechModelCancelDownload',
    'speechModelRemove', 'speechModelWarm', 'speechModelUnload',
  ]) {
    assert.match(preloadSource, new RegExp(`\\b${method}:`));
  }
  assert.match(preloadSource, /'speech:model-progress'/);
});

test('native worker source exposes batch, VAD, and streaming commands without diarization', () => {
  assert.match(nativeWorker, /StreamCommand|ActiveStream/);
  assert.match(nativeWorker, /VadSession/);
  assert.doesNotMatch(nativeWorker, /DiarizeSession|DiarizeInfo|Sortformer|speakerId/);
  assert.doesNotMatch(nativeWorker, /"diarize-[a-z-]+"/);
  for (const command of ['hardware-info', 'load', 'warm', 'transcribe', 'unload', 'vad-load', 'vad-detect', 'vad-unload', 'stream-start', 'stream-feed', 'stream-boundary']) {
    assert.match(nativeWorker, new RegExp(`"${command}" =>`), `${command} is dispatched`);
  }
  assert.match(nativeWorker, /"stream-finish" \| "stream-cancel" =>/, 'finish and cancel share a dispatch arm');
});

test('speech backend status belongs only to the loaded model', () => {
  assert.match(mainSource, /backend: defaultSpeechWorker\.loadedModelId === model\.id \? defaultSpeechWorker\.activeBackend : ''/);
  assert.match(mainSource, /backendFallback: defaultSpeechWorker\.loadedModelId === model\.id \? defaultSpeechWorker\.activeBackendFallback : false/);
  assert.match(rendererSource, /model\.loaded && model\.backend \? `Backend:/);
  assert.match(rendererSource, /model\.loaded && model\.backendFallback \? 'CPU fallback active'/);
});

test('native speech worker supports a model-free self-test payload', () => {
  assert.match(nativeWorker, /--self-test/);
  assert.match(nativeWorker, /"engine": "transcribe-cpp"/);
  assert.match(nativeWorker, /"protocol": 1/);
});
