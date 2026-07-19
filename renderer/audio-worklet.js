class StreamingLinearResampler {
  constructor(sourceRate, targetRate) {
    this.sourceRate = Math.max(1, Number(sourceRate) || 48000);
    this.targetRate = Math.max(1, Number(targetRate) || 24000);
    this.ratio = this.sourceRate / this.targetRate;
    this.buffer = new Float32Array(0);
    this.position = 0;
  }

  push(input) {
    if (!input || !input.length) return new Float32Array(0);
    const samples = new Float32Array(this.buffer.length + input.length);
    samples.set(this.buffer);
    samples.set(input, this.buffer.length);
    const output = [];
    while (this.position + 1 < samples.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      output.push(samples[index] + (samples[index + 1] - samples[index]) * fraction);
      this.position += this.ratio;
    }
    const consumed = Math.min(samples.length, Math.floor(this.position));
    this.buffer = samples.slice(consumed);
    this.position -= consumed;
    return Float32Array.from(output);
  }
}

class VolyxLensPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    this.chunkSize = 2048;
    this.targetSampleRate = Math.max(8000, Number(options.processorOptions && options.processorOptions.targetSampleRate) || 24000);
    this.sourceSampleRate = sampleRate;
    this.resampler = new StreamingLinearResampler(this.sourceSampleRate, this.targetSampleRate);
    this.pending = new Float32Array(this.chunkSize);
    this.offset = 0;
    this.peak = 0;
    this.port.postMessage({ type: 'format', sourceSampleRate: this.sourceSampleRate, targetSampleRate: this.targetSampleRate });
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (output) output.fill(0);
    if (!input || !input.length) return true;

    const resampled = this.resampler.push(input);
    for (let index = 0; index < resampled.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, resampled[index]));
      this.pending[this.offset++] = sample;
      this.peak = Math.max(this.peak, Math.abs(sample));
      if (this.offset === this.chunkSize) {
        const pcm = new Int16Array(this.chunkSize);
        for (let i = 0; i < this.chunkSize; i += 1) {
          const value = this.pending[i];
          pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
        }
        const buffer = pcm.buffer;
        this.port.postMessage({
          type: 'pcm',
          buffer,
          level: this.peak,
          sourceSampleRate: this.sourceSampleRate,
          targetSampleRate: this.targetSampleRate,
        }, [buffer]);
        this.offset = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('volyx-lens-pcm-capture', VolyxLensPcmCaptureProcessor);

if (typeof module !== 'undefined') module.exports = { StreamingLinearResampler };
