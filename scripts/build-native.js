const { buildVisionOcr } = require('./build-vision-ocr');

buildVisionOcr({
  appDir: require('node:path').resolve(__dirname, '..'),
  electronPlatformName: process.platform,
  arch: process.arch,
}).catch((error) => {
  console.error(error && error.message ? error.message : 'Could not build native helpers.');
  process.exitCode = 1;
});
