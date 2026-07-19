const test = require('node:test');
const assert = require('node:assert/strict');

const { VoiceActivityDetector } = require('../src/voice-activity');

function pcm(amplitude, samples = 4096) {
  const data = new Int16Array(samples);
  data.fill(amplitude);
  return Buffer.from(data.buffer);
}

test('VAD starts on speech and stops after configured silence', () => {
  const vad = new VoiceActivityDetector({ sampleRate: 24000, threshold: 500, silenceMs: 300, maxUtteranceMs: 10000 });

  const started = vad.push(pcm(1200));
  assert.equal(started.speechStarted, true);
  assert.equal(started.active, true);

  const firstSilence = vad.push(pcm(0));
  assert.equal(firstSilence.speechStopped, false);
  const secondSilence = vad.push(pcm(0));
  assert.equal(secondSilence.speechStopped, true);
  assert.equal(secondSilence.active, false);
});

test('VAD ignores silence before speech and bounds long utterances', () => {
  const vad = new VoiceActivityDetector({ sampleRate: 24000, threshold: 500, silenceMs: 1000, maxUtteranceMs: 300 });

  assert.deepEqual(
    (({ active, speechStarted, speechStopped, forced }) => ({ active, speechStarted, speechStopped, forced }))(vad.push(pcm(0))),
    { active: false, speechStarted: false, speechStopped: false, forced: false },
  );
  assert.equal(vad.push(pcm(1200)).speechStarted, true);
  const forced = vad.push(pcm(1200));
  assert.equal(forced.speechStopped, true);
  assert.equal(forced.forced, true);
  assert.equal(forced.active, true);
});

test('reset clears an active utterance', () => {
  const vad = new VoiceActivityDetector({ sampleRate: 24000, threshold: 500 });
  vad.push(pcm(1200));
  vad.reset();
  assert.equal(vad.push(pcm(0)).active, false);
});

test('adaptive noise floor rejects steady background noise while allowing louder speech', () => {
  const vad = new VoiceActivityDetector({ sampleRate: 24000, threshold: 100, minSpeechMs: 20 });
  for (let i = 0; i < 50; i += 1) vad.push(pcm(80, 480));
  assert.equal(vad.push(pcm(150, 480)).speechStarted, false);
  assert.equal(vad.push(pcm(600, 480)).speechStarted, true);
});
