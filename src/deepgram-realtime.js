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
    reconnectAttempts: 0,
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
    this.opened = false;
    this.client = null;
    this.connectPromise = null;
    this.cancelConnect = null;
    this.cancelPromise = null;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.disposedConnections = new WeakSet();
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
    this.cancelPromise = new Promise((_, reject) => {
      this.cancelConnect = () => {
        const error = new Error('Deepgram connection cancelled.');
        error.code = 'connection_cancelled';
        reject(error);
      };
    });
    this.connectPromise = this._connect();
    return this.connectPromise;
  }

  async _connect() {
    const Client = this.DeepgramClientImpl || require('@deepgram/sdk').DeepgramClient;
    this.client = new Client({ apiKey: this.apiKey, reconnect: false });
    this.apiKey = '';
    const connectionPromise = this.client.listen.v1.connect(buildDeepgramOptions({
      model: this.model,
      language: this.language,
      sampleRate: this.sampleRate,
    }));
    void connectionPromise.then((lateConnection) => {
      if (this.intentionalClose) this._disposeConnection(lateConnection, false);
    }).catch(() => {});
    let connection;
    try {
      connection = await Promise.race([connectionPromise, this.cancelPromise]);
    } catch (error) {
      if (this.intentionalClose || error.code === 'connection_cancelled') throw new Error('Deepgram connection cancelled.');
      const clean = sanitizeDeepgramError(error, this.channel);
      this._reportError(clean);
      throw new Error(clean.message);
    }
    if (this.intentionalClose) {
      this._disposeConnection(connection, false);
      throw new Error('Deepgram connection cancelled.');
    }
    this.connection = connection;
    let rejectPreOpen = null;
    let opening = true;
    const preOpenFailure = new Promise((_, reject) => { rejectPreOpen = reject; });
    const failPreOpen = (clean) => {
      this._reportError(clean);
      if (!opening || !rejectPreOpen || this.intentionalClose) return;
      const error = new Error(clean.message);
      error.code = clean.code;
      const reject = rejectPreOpen;
      rejectPreOpen = null;
      reject(error);
    };
    connection.on('open', () => this.onState({ channel: this.channel, state: 'connected' }));
    connection.on('message', (event) => this._handleMessage(event));
    connection.on('error', (error) => failPreOpen(sanitizeDeepgramError(error, this.channel)));
    connection.on('close', () => {
      this._clearKeepAlive();
      this.onState({ channel: this.channel, state: this.intentionalClose ? 'stopped' : 'disconnected' });
      if (!this.intentionalClose) failPreOpen(sanitizeDeepgramError({ code: 'socket_closed' }, this.channel));
    });
    connection.connect();
    let timer = null;
    try {
      await Promise.race([
        connection.waitForOpen(),
        preOpenFailure,
        this.cancelPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Deepgram connection timeout.')), this.connectTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (this.intentionalClose || error.code === 'connection_cancelled') {
        this._disposeConnection(connection, false);
        throw new Error('Deepgram connection cancelled.');
      }
      const clean = sanitizeDeepgramError(error, this.channel);
      this._reportError(clean);
      this.close();
      throw new Error(clean.message);
    } finally {
      opening = false;
      rejectPreOpen = null;
      if (timer) clearTimeout(timer);
    }
    if (this.intentionalClose) {
      this._disposeConnection(connection, false);
      throw new Error('Deepgram connection cancelled.');
    }
    this.opened = true;
    this.streamStartedAt = Date.now();
    this.lastMediaAt = this.streamStartedAt;
    this._startKeepAlive();
    const pending = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    for (const buffer of pending) {
      if (!this._sendMedia(buffer)) break;
    }
  }

  append(pcm) {
    const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    if (!buffer.length || this.intentionalClose) return false;
    if (!this.opened || !this.connection) {
      if (!this.connectPromise) return false;
      if (this.pendingAudioBytes + buffer.length > this.maxBufferedBytes) {
        this._reportError({
          code: 'realtime_transport_failed',
          message: 'Deepgram transcription pre-connect buffer exceeded its safety limit.',
          channel: this.channel,
        });
        return false;
      }
      this.pendingAudio.push(Buffer.from(buffer));
      this.pendingAudioBytes += buffer.length;
      return true;
    }
    return this._sendMedia(buffer);
  }

  _sendMedia(buffer) {
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
    if (this.cancelConnect) this.cancelConnect();
    this.cancelConnect = null;
    this._clearKeepAlive();
    const connection = this.connection;
    this.connection = null;
    this.opened = false;
    if (connection) this._disposeConnection(connection, true);
    this.client = null;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.completed.clear();
  }

  _disposeConnection(connection, sendCloseStream) {
    if (!connection || this.disposedConnections.has(connection)) return;
    this.disposedConnections.add(connection);
    if (sendCloseStream) {
      try { connection.sendCloseStream({ type: 'CloseStream' }); } catch {}
    }
    try { connection.close(); } catch {}
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
