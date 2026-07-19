const { rms16 } = require('./wav');

class VoiceActivityDetector {
  constructor({
    sampleRate = 24000,
    threshold = 240,
    silenceMs = 700,
    maxUtteranceMs = 20000,
    minSpeechMs = 80,
    noiseMultiplier = 2.5,
    releaseThresholdRatio = 0.65,
  } = {}) {
    this.sampleRate = sampleRate;
    this.threshold = threshold;
    this.silenceMs = silenceMs;
    this.maxUtteranceMs = maxUtteranceMs;
    this.minSpeechMs = minSpeechMs;
    this.noiseMultiplier = noiseMultiplier;
    this.releaseThresholdRatio = releaseThresholdRatio;
    this.noiseFloor = Math.max(20, threshold * 0.25);
    this.reset();
  }

  reset() {
    this.active = false;
    this.silenceDurationMs = 0;
    this.utteranceDurationMs = 0;
    this.pendingSpeechMs = 0;
  }

  push(pcm) {
    const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    const durationMs = this.sampleRate > 0 ? (buffer.length / 2 / this.sampleRate) * 1000 : 0;
    const level = buffer.length >= 2 ? rms16(buffer) : 0;
    const startThreshold = Math.max(this.threshold, this.noiseFloor * this.noiseMultiplier);
    const continueThreshold = Math.max(this.threshold * this.releaseThresholdRatio, this.noiseFloor * 1.5);
    const speaking = level >= (this.active ? continueThreshold : startThreshold);
    let speechStarted = false;
    let speechStopped = false;
    let forced = false;

    if (!this.active) {
      if (speaking) {
        this.pendingSpeechMs += durationMs;
        if (this.pendingSpeechMs >= this.minSpeechMs) {
          this.active = true;
          this.silenceDurationMs = 0;
          this.utteranceDurationMs = this.pendingSpeechMs;
          this.pendingSpeechMs = 0;
          speechStarted = true;
        }
      } else {
        this.pendingSpeechMs = 0;
        const cappedLevel = Math.min(level, this.threshold * 1.5);
        this.noiseFloor = this.noiseFloor * 0.95 + cappedLevel * 0.05;
      }
    }

    if (this.active && !speechStarted) {
      this.utteranceDurationMs += durationMs;
    }
    if (this.active) {
      if (speaking) this.silenceDurationMs = 0;
      else this.silenceDurationMs += durationMs;

      if (this.utteranceDurationMs >= this.maxUtteranceMs) {
        speechStopped = true;
        forced = true;
        this.utteranceDurationMs = 0;
        this.silenceDurationMs = 0;
      } else if (this.silenceDurationMs >= this.silenceMs) {
        speechStopped = true;
        this.active = false;
        this.utteranceDurationMs = 0;
        this.silenceDurationMs = 0;
      }
    }

    return { active: this.active, speechStarted, speechStopped, forced, level, startThreshold };
  }
}

module.exports = { VoiceActivityDetector };
