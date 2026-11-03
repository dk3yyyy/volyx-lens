const AUDIO_SAMPLE_RATE = 24000;
const PCM_BYTES_PER_SAMPLE = 2;

// One buffered capture chunk is one worklet frame: 2048 Int16 samples
// (renderer/audio-worklet.js; the native system-audio frames carry the same
// 4096-byte payload). Keeping the size here lets main estimate how much speech
// a dropped drain buffer represents instead of guessing from byte counts.
const AUDIO_CHUNK_SAMPLES = 2048;
const AUDIO_CHUNK_DURATION_MS = (AUDIO_CHUNK_SAMPLES / AUDIO_SAMPLE_RATE) * 1000;

module.exports = { AUDIO_SAMPLE_RATE, PCM_BYTES_PER_SAMPLE, AUDIO_CHUNK_SAMPLES, AUDIO_CHUNK_DURATION_MS };
