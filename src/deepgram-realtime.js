'use strict';

const DEFAULT_MODEL = 'nova-3';
const DEFAULT_ENDPOINTING_MS = 300;
const DEFAULT_UTTERANCE_END_MS = 1000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_KEEPALIVE_MS = 5000;

function buildDeepgramOptions({ model = DEFAULT_MODEL, language = '', sampleRate = 24000 } = {}) {
  const options = {
    model: String(model || DEFAULT_MODEL),
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    endpointing: String(DEFAULT_ENDPOINTING_MS),
    utterance_end_ms: String(DEFAULT_UTTERANCE_END_MS),
    vad_events: 'true',
  };
  const normalizedLanguage = String(language || '').trim().toLowerCase();
  if (normalizedLanguage && !['auto', 'automatic'].includes(normalizedLanguage)) options.language = normalizedLanguage;
  return options;
}

function sanitizeDeepgramError(error, channel) {
  const candidate = [error && error.code, error && error.type, error && error.message]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');
  if (/(auth|token|api.?key|401|403)/.test(candidate)) {
    return { code: 'realtime_authentication_failed', message: 'Deepgram authentication failed.', channel };
  }
  if (candidate.includes('timeout')) {
    return { code: 'realtime_connection_timeout', message: 'Deepgram transcription connection timed out.', channel };
  }
  if (/(rate|limit|429)/.test(candidate)) {
    return { code: 'realtime_rate_limited', message: 'Deepgram transcription rate limit was reached.', channel };
  }
  return { code: 'realtime_transport_failed', message: 'Deepgram transcription connection failed.', channel };
}

class DeepgramRealtimeChannel {
  constructor({
    apiKey,
    channel,
    model = DEFAULT_MODEL,
    language = '',
    sampleRate = 24000,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    keepAliveMs = DEFAULT_KEEPALIVE_MS,
    maxBufferedBytes = sampleRate * 2 * 5,
    DeepgramClientImpl,
    onPartial = () => {},
    onFinal = () => {},
    onError = () => {},
    onState = () => {},
    onLatency = () => {},
  }) {
    this.apiKey = String(apiKey || '');
    this.channel = channel;
    this.model = model || DEFAULT_MODEL;
    this.language = language;
    this.sampleRate = sampleRate;
    this.connectTimeoutMs = connectTimeoutMs;
    this.keepAliveMs = keepAliveMs;
    this.maxBufferedBytes = maxBufferedBytes;
    this.DeepgramClientImpl = DeepgramClientImpl;
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.onError = onError;
    this.onState = onState;
    this.onLatency = onLatency;
    this.connection = null;
    this.client = null;
    this.connectPromise = null;
    this.keepAliveTimer = null;
    this.lastMediaAt = 0;
    this.streamStartedAt = 0;
    this.audioSentMs = 0;
    this.completed = new Set();
    this.intentionalClose = false;
    this.failureReported = false;
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    this.onState({ channel: this.channel, state: 'connecting' });
    this.connectPromise = this._connect();
    return this.connectPromise;
  }

  async _connect() {
    const Client = this.DeepgramClientImpl || require('@deepgram/sdk').DeepgramClient;
    this.client = new Client({ apiKey: this.apiKey, reconnect: false });
    this.apiKey = '';
    const connection = await this.client.listen.v1.connect(buildDeepgramOptions({
      model: this.model,
      language: this.language,
      sampleRate: this.sampleRate,
    }));
    this.connection = connection;
    connection.on('open', () => this.onState({ channel: this.channel, state: 'connected' }));
    connection.on('message', (event) => this._handleMessage(event));
    connection.on('error', (error) => this._reportError(sanitizeDeepgramError(error, this.channel)));
    connection.on('close', () => {
      this._clearKeepAlive();
      this.onState({ channel: this.channel, state: this.intentionalClose ? 'stopped' : 'disconnected' });
      if (!this.intentionalClose) this._reportError(sanitizeDeepgramError({ code: 'socket_closed' }, this.channel));
    });
    connection.connect();
    let timer = null;
    try {
      await Promise.race([
        connection.waitForOpen(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Deepgram connection timeout.')), this.connectTimeoutMs);
        }),
      ]);
    } catch (error) {
      const clean = sanitizeDeepgramError(error, this.channel);
      this._reportError(clean);
      this.close();
      throw new Error(clean.message);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.streamStartedAt = Date.now();
    this.lastMediaAt = this.streamStartedAt;
    this._startKeepAlive();
  }

  append(pcm) {
    const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    if (!buffer.length || !this.connection || this.intentionalClose) return false;
    const bufferedAmount = Number((this.connection.socket && this.connection.socket.bufferedAmount) || 0);
    if (bufferedAmount + buffer.length > this.maxBufferedBytes) {
      this._reportError({
        code: 'realtime_transport_failed',
        message: 'Deepgram transcription network buffer exceeded its safety limit.',
        channel: this.channel,
      });
      return false;
    }
    try {
      this.connection.sendMedia(buffer);
      this.lastMediaAt = Date.now();
      this.audioSentMs += (buffer.length / 2 / this.sampleRate) * 1000;
      return true;
    } catch (error) {
      this._reportError(sanitizeDeepgramError(error, this.channel));
      return false;
    }
  }

  commit() {
    if (!this.connection || this.intentionalClose) return;
    try { this.connection.sendFinalize({ type: 'Finalize' }); }
    catch (error) { this._reportError(sanitizeDeepgramError(error, this.channel)); }
  }

  close() {
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    this._clearKeepAlive();
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try { connection.sendCloseStream({ type: 'CloseStream' }); } catch {}
      try { connection.close(); } catch {}
    }
    this.client = null;
    this.completed.clear();
  }

  _handleMessage(event) {
    if (!event || event.type !== 'Results') return;
    const alternative = event.channel && Array.isArray(event.channel.alternatives)
      ? event.channel.alternatives[0]
      : null;
    const text = String((alternative && alternative.transcript) || '').trim();
    if (!text) return;
    const startMs = Math.max(0, Math.round((Number(event.start) || 0) * 1000));
    const durationMs = Math.max(0, Math.round((Number(event.duration) || 0) * 1000));
    const itemId = `deepgram-${this.channel}-${startMs}`;
    const latencyMs = Math.max(0, Math.round(this.audioSentMs - startMs - durationMs));
    if (event.is_final === true) {
      const completionId = `${itemId}-${durationMs}`;
      if (this.completed.has(completionId)) return;
      this.completed.add(completionId);
      if (this.completed.size > 500) this.completed.delete(this.completed.values().next().value);
      this.onLatency({ channel: this.channel, kind: 'final', latencyMs });
      this.onFinal({
        channel: this.channel,
        itemId: completionId,
        text,
        ts: Date.now(),
      });
      return;
    }
    this.onLatency({ channel: this.channel, kind: 'first_partial', latencyMs });
    this.onPartial({ channel: this.channel, itemId, text });
  }

  _startKeepAlive() {
    this._clearKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.connection || this.intentionalClose || Date.now() - this.lastMediaAt < this.keepAliveMs - 500) return;
      try { this.connection.sendKeepAlive({ type: 'KeepAlive' }); }
      catch (error) { this._reportError(sanitizeDeepgramError(error, this.channel)); }
    }, this.keepAliveMs);
    if (typeof this.keepAliveTimer.unref === 'function') this.keepAliveTimer.unref();
  }

  _clearKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  _reportError(error) {
    if (this.failureReported || this.intentionalClose) return;
    this.failureReported = true;
    this.onError(error);
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_ENDPOINTING_MS,
  DEFAULT_UTTERANCE_END_MS,
  buildDeepgramOptions,
  sanitizeDeepgramError,
  DeepgramRealtimeChannel,
};
