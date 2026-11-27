const { buildVisionOcr } = require('./build-vision-ocr');
const { buildSpeechWorker } = require('./build-speech-worker');

const context = {
  appDir: require('node:path').resolve(__dirname, '..'),
  electronPlatformName: process.platform,
  arch: process.arch,
};

Promise.all([buildVisionOcr(context), buildSpeechWorker(context)]).catch((error) => {
  console.error(error && error.message ? error.message : 'Could not build native helpers.');
  process.exitCode = 1;
});
