const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AUDIO_SAMPLE_RATE } = require('../src/audio-config');
const { pcmToWav } = require('../src/wav');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const stt = fs.readFileSync(path.join(root, 'src', 'stt.js'), 'utf8');

test('capture and batch fallback share the required 24 kHz sample rate', () => {
  assert.equal(AUDIO_SAMPLE_RATE, 24000);
  assert.match(renderer, /volyxLens\.audioConfig\.sampleRate/);
  assert.match(stt, /pcmToWav\(pcm, AUDIO_SAMPLE_RATE, 1\)/);

  const wav = pcmToWav(Buffer.alloc(2400 * 2), AUDIO_SAMPLE_RATE, 1);
  assert.equal(wav.readUInt32LE(24), 24000);
});
