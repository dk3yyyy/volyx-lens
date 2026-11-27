'use strict';

// electron-builder runs exactly one beforePack hook, so this is the place where
// the native helpers are compiled (macOS only) and the pinned whisper.cpp server
// is downloaded for the target platform. Both steps are idempotent: pack twice
// and the second run only verifies what is already in native-bin/.
//
// build-vision-ocr.js is kept as a standalone module because its own tests and
// the Swift build scripts call it directly.

const { buildVisionOcr } = require('./build-vision-ocr');
const { buildSpeechWorker } = require('./build-speech-worker');
const { prepareWhisperRuntime } = require('./prepare-whisper-runtime');

async function beforePack(context = {}, dependencies = {}) {
  const buildVision = dependencies.buildVisionOcr || buildVisionOcr;
  const buildSpeech = dependencies.buildSpeechWorker || buildSpeechWorker;
  const prepareWhisper = dependencies.prepareWhisperRuntime || prepareWhisperRuntime;
  await Promise.all([buildVision(context), buildSpeech(context)]);
  return prepareWhisper({
    platform: context.electronPlatformName || process.platform,
    // electron-builder reports the Arch enum (1 = x64, 3 = arm64); the manifest
    // normalizes that spelling.
    arch: context.arch === undefined ? process.arch : context.arch,
    projectDir: context.appDir,
  });
}

exports.default = beforePack;
module.exports.beforePack = beforePack;
