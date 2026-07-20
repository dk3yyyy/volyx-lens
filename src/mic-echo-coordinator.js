'use strict';

const DEFAULT_MIC_INSPECTION_DELAY_MS = 250;
const DEFAULT_SAMPLE_RATE = 24000;

class MicEchoCoordinator {
  constructor({
    filter,
    delayMs = DEFAULT_MIC_INSPECTION_DELAY_MS,
    maxBytes = DEFAULT_SAMPLE_RATE * 2 * 4,
    clock = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onMicrophone = () => {},
  } = {}) {
    if (!filter || typeof filter.observeSystem !== 'function') throw new TypeError('An acoustic echo filter is required.');
    this.filter = filter;
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.maxBytes = Math.max(1, Number(maxBytes) || DEFAULT_SAMPLE_RATE * 2 * 4);
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onMicrophone = onMicrophone;
    this.queue = [];
    this.queuedBytes = 0;
    this.timer = null;
  }

  observeSystem(pcm) {
    this.filter.observeSystem(pcm);
    return this.flushReady();
  }

  enqueueMicrophone(pcm) {
    const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    this.flushReady();
    if (!buffer.length || this.queuedBytes + buffer.length > this.maxBytes) return false;
    this.queue.push({ pcm: buffer, readyAt: this.clock() + this.delayMs });
    this.queuedBytes += buffer.length;
    this._scheduleTimer();
    return true;
  }

  flushReady({ force = false } = {}) {
    this._cancelTimer();
    const now = this.clock();
    let processed = 0;
    while (this.queue.length && (force || this.queue[0].readyAt <= now)) {
      const item = this.queue.shift();
      this.queuedBytes -= item.pcm.length;
      this.onMicrophone(item.pcm);
      processed += 1;
    }
    this._scheduleTimer();
    return processed;
  }

  drain() {
    return this.flushReady({ force: true });
  }

  clear() {
    this._cancelTimer();
    this.queue = [];
    this.queuedBytes = 0;
  }

  _scheduleTimer() {
    if (this.timer || !this.queue.length) return;
    const delay = Math.max(0, this.queue[0].readyAt - this.clock());
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flushReady();
    }, delay);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  _cancelTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

function createMicEchoCoordinator(options) {
  return new MicEchoCoordinator(options);
}

module.exports = {
  DEFAULT_MIC_INSPECTION_DELAY_MS,
  MicEchoCoordinator,
  createMicEchoCoordinator,
};
