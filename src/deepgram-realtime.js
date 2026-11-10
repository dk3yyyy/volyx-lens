'use strict';

const { STT_MODELS } = require('./provider-config');
const { classifyRealtimeError } = require('./realtime-errors');

const DEFAULT_MODEL = STT_MODELS.deepgram;
const DEFAULT_ENDPOINTING_MS = 300;
const DEFAULT_UTTERANCE_END_MS = 1000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_KEEPALIVE_MS = 5000;
const DEFAULT_DRAIN_TIMEOUT_MS = 750;
const DEFAULT_MAX_COMMITTED_CHARS = 12000;
const MAX_KEYTERM_COUNT = 50;
const MAX_KEYTERM_TOKENS = 450;
const MAX_COMPLETED_KEYS = 500;

// `multi` is valid for Nova-2/Nova-3 general and Nova-3 medical. Specialized
// English-only models (nova-3-pharma, nova-2-meeting, ...) and fine-tuned ids
// must not be sent a language they do not support.
function supportsDeepgramMultilingual(model) {
  const normalized = String(model || '').trim().toLowerCase();
  return /^nova-(?:2|3)(?:-general)?$/.test(normalized)
    || normalized === 'nova-3-medical'
    || normalized === 'flux-general-multi';
}

function buildDeepgramOptions({ model = DEFAULT_MODEL, language = '', sampleRate = 24000, keyterms = [] } = {}) {
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
  // Preserve the provider's canonical casing (for example zh-HK); only trim.
  // Auto detection is a Nova-3 feature expressed as `multi`. On models that
  // cannot auto-detect, leave the parameter off rather than silently asking
  // for English.
  const trimmedLanguage = String(language || '').trim();
  const normalizedLanguage = trimmedLanguage.toLowerCase();
  if (['auto', 'automatic'].includes(normalizedLanguage)) {
    if (supportsDeepgramMultilingual(options.model)) options.language = 'multi';
  } else if (trimmedLanguage) {
    options.language = trimmedLanguage;
  }
  // Keyterm prompting is a Nova-3 feature. Older models reject the parameter,
  // so it is only attached when the model can take it. Bound both the entry
  // count and the cumulative whitespace token count.
  const terms = [];
  let tokenCount = 0;
  for (const term of (Array.isArray(keyterms) ? keyterms : [])) {
    if (terms.length >= MAX_KEYTERM_COUNT) break;
    const cleaned = String(term || '').trim();
    if (!cleaned) continue;
    const termTokens = cleaned.split(/\s+/).filter(Boolean).length;
    if (tokenCount + termTokens > MAX_KEYTERM_TOKENS) break;
    terms.push(cleaned);
    tokenCount += termTokens;
  }
  if (terms.length && /nova-3/i.test(options.model)) options.keyterm = terms;
  return options;
}

// Thin provider-tuned alias to the shared classifier in realtime-errors.js;
// Deepgram adds a rate-limit category and uses its own provider wording.
const sanitizeDeepgramError = (error, channel) => classifyRealtimeError(error, channel, { providerLabel: 'Deepgram transcription', includeRateLimit: true });

class DeepgramRealtimeChannel {
  constructor({
    apiKey,
    channel,
    model = DEFAULT_MODEL,
    language = '',
    sampleRate = 24000,
    keyterms = [],
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    keepAliveMs = DEFAULT_KEEPALIVE_MS,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    maxBufferedBytes = sampleRate * 2 * 5,
    maxCommittedChars = DEFAULT_MAX_COMMITTED_CHARS,
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
    this.keyterms = Array.isArray(keyterms) ? keyterms : [];
    this.connectTimeoutMs = connectTimeoutMs;
    this.keepAliveMs = keepAliveMs;
    this.drainTimeoutMs = drainTimeoutMs;
    this.maxBufferedBytes = maxBufferedBytes;
    this.maxCommittedChars = maxCommittedChars;
    this.DeepgramClientImpl = DeepgramClientImpl;
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.onError = onError;
    this.onState = onState;
    this.onLatency = onLatency;
    this.connection = null;
    this.opened = false;
    this.stopping = false;
    this.client = null;
    this.connectPromise = null;
    this.cancelConnect = null;
    this.cancelPromise = null;
    this.closePromise = null;
    this.drainResolve = null;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.disposedConnections = new WeakSet();
    this.keepAliveTimer = null;
    this.lastMediaAt = 0;
    this.streamStartedAt = 0;
    this.audioSentMs = 0;
    this.completed = new Set();
    this.committed = '';
    this.intentionalClose = false;
    this.closed = false;
    this.failed = false;
    this.failureReported = false;
    this.configurationReported = false;
    this.sequence = 0;
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
    // A close() before anything races the cancellation promise (for example a
    // synchronous SDK client-construction failure) must not surface as an
    // unhandled rejection.
    this.cancelPromise.catch(() => {});
    this.connectPromise = this._connect();
    return this.connectPromise;
  }

  async _connect() {
    let timer = null;
    let opening = true;
    let rejectPreOpen = null;
    // The timeout covers SDK client construction and listen.v1.connect() as
    // well as waitForOpen(); a connect() that never settles used to hang.
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Deepgram connection timeout.');
        error.code = 'connection_timeout';
        reject(error);
      }, this.connectTimeoutMs);
    });
    timeoutPromise.catch(() => {});
    try {
      let connection;
      try {
        const Client = this.DeepgramClientImpl || require('@deepgram/sdk').DeepgramClient;
        this.client = new Client({ apiKey: this.apiKey, reconnect: false });
        this.apiKey = '';
        const connectionPromise = Promise.resolve().then(() => this.client.listen.v1.connect(buildDeepgramOptions({
          model: this.model,
          language: this.language,
          sampleRate: this.sampleRate,
          keyterms: this.keyterms,
        })));
        void connectionPromise.then((lateConnection) => {
          if (this.intentionalClose) this._disposeConnection(lateConnection, false);
        }).catch(() => {});
        connection = await Promise.race([connectionPromise, this.cancelPromise, timeoutPromise]);
      } catch (error) {
        if (error && error.code === 'connection_cancelled') throw new Error('Deepgram connection cancelled.');
        const clean = sanitizeDeepgramError(error, this.channel);
        this._reportError(clean);
        await this.close();
        throw new Error(clean.message);
      }
      if (this.intentionalClose) {
        this._disposeConnection(connection, false);
        throw new Error('Deepgram connection cancelled.');
      }
      this.connection = connection;
      const preOpenFailure = new Promise((_, reject) => { rejectPreOpen = reject; });
      preOpenFailure.catch(() => {});
      const handleTransportFailure = (clean) => {
        if (opening && rejectPreOpen && !this.intentionalClose) {
          const error = new Error(clean.message);
          error.code = clean.code;
          const reject = rejectPreOpen;
          rejectPreOpen = null;
          reject(error);
        }
        this._reportError(clean);
      };
      connection.on('open', () => this.onState({ channel: this.channel, state: 'connected' }));
      connection.on('message', (event) => this._handleMessage(event));
      connection.on('error', (error) => handleTransportFailure(sanitizeDeepgramError(error, this.channel)));
      connection.on('close', () => {
        this._clearKeepAlive();
        if (this.connection === connection) this.connection = null;
        this.opened = false;
        this._finishDrain();
        this.onState({ channel: this.channel, state: this.intentionalClose ? 'stopped' : 'disconnected' });
        if (!this.intentionalClose) {
          this.failed = true;
          handleTransportFailure(sanitizeDeepgramError({ code: 'socket_closed' }, this.channel));
        }
      });
      try {
        connection.connect();
        await Promise.race([
          connection.waitForOpen(),
          preOpenFailure,
          this.cancelPromise,
          timeoutPromise,
        ]);
      } catch (error) {
        if (error && error.code === 'connection_cancelled') {
          this._disposeConnection(connection, false);
          throw new Error('Deepgram connection cancelled.');
        }
        const clean = sanitizeDeepgramError(error, this.channel);
        this._reportError(clean);
        await this.close();
        throw new Error(clean.message);
      } finally {
        opening = false;
        rejectPreOpen = null;
      }
      if (this.intentionalClose) {
        this._disposeConnection(connection, false);
        throw new Error('Deepgram connection cancelled.');
      }
      this.opened = true;
      this.streamStartedAt = Date.now();
      this.lastMediaAt = this.streamStartedAt;
      this._startKeepAlive();
      this._replayPendingAudio();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Replay pre-connect audio without losing the tail when a send fails: only
  // buffers that were actually handed to the socket leave the queue.
  _replayPendingAudio() {
    if (!this.pendingAudio.length) return;
    const pending = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    let sent = 0;
    for (; sent < pending.length; sent++) {
      if (!this._sendMedia(pending[sent])) break;
    }
    if (sent < pending.length) {
      this.pendingAudio = pending.slice(sent);
      this.pendingAudioBytes = this.pendingAudio.reduce((total, buffer) => total + buffer.length, 0);
    }
  }

  append(pcm) {
    const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    // A failed or closed channel must not keep accepting audio: the manager
    // turns this false return into its batch fallback.
    if (!buffer.length || this.intentionalClose || this.closed || this.failed) return false;
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
    // A replay may have retained an unsent tail after a transient send failure.
    // Queue behind it and try the whole ordered queue again, rather than sending
    // new audio ahead of older audio or leaving the tail permanently stranded.
    if (this.pendingAudio.length) {
      if (this.pendingAudioBytes + buffer.length > this.maxBufferedBytes) {
        this._reportError({
          code: 'realtime_transport_failed',
          message: 'Deepgram transcription replay buffer exceeded its safety limit.',
          channel: this.channel,
        });
        return false;
      }
      this.pendingAudio.push(Buffer.from(buffer));
      this.pendingAudioBytes += buffer.length;
      this._replayPendingAudio();
      return true;
    }
    return this._sendMedia(buffer);
  }

  _sendMedia(buffer) {
    if (!this.connection) return false;
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
    // Before the socket is open there is nothing to finalise, and sendFinalize on a
    // connecting socket throws into the fatal error path (VR-14). A throw from an
    // open socket during a requested stop is suppressed by `stopping`, not skipped
    // here, so an ordinary stop still finalises the last utterance.
    if (!this.connection || !this.opened || this.intentionalClose) return;
    try { this.connection.sendFinalize({ type: 'Finalize' }); }
    catch (error) { this._reportError(sanitizeDeepgramError(error, this.channel)); }
  }

  // Sends CloseStream, gives the provider a bounded window to deliver its last
  // final Results/Metadata, then flushes anything still committed and closes
  // the socket. The manager awaits this, so a late final is not discarded.
  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this._close();
    return this.closePromise;
  }

  async _close() {
    this.intentionalClose = true;
    this.stopping = true;
    if (this.cancelConnect) {
      try { this.cancelConnect(); } catch { /* rejection is observed via cancelPromise */ }
    }
    this.cancelConnect = null;
    this._clearKeepAlive();
    const connection = this.connection;
    const wasOpen = !!(connection && this.opened);
    this.opened = false;
    if (wasOpen) {
      const drained = new Promise((resolve) => {
        let timer = null;
        const finish = () => {
          if (this.drainResolve !== finish) return;
          this.drainResolve = null;
          if (timer) clearTimeout(timer);
          resolve();
        };
        this.drainResolve = finish;
        timer = setTimeout(finish, this.drainTimeoutMs);
      });
      // Register the drain before sendCloseStream: a synchronous fake or server
      // close during sendCloseStream must not be missed.
      this._sendCloseStream(connection);
      await drained;
    }
    // A final may have arrived from_finalize without speech_final, or no final
    // may arrive at all: never drop the tail on the floor. Teardown still runs
    // if a final callback throws.
    try {
      this._flushCommitted();
    } catch {
      // A consumer callback must not turn a completed teardown into a rejected
      // close() promise; the manager and diagnostic call close() without a catch.
    } finally {
      this.connection = null;
      this.client = null;
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;
      this.completed.clear();
      if (connection) this._disposeConnection(connection, false);
      this.closed = true;
    }
  }

  _sendCloseStream(connection) {
    if (!connection) return;
    try { connection.sendCloseStream({ type: 'CloseStream' }); } catch {}
  }

  _disposeConnection(connection, sendCloseStream) {
    if (!connection || this.disposedConnections.has(connection)) return;
    this.disposedConnections.add(connection);
    if (sendCloseStream) this._sendCloseStream(connection);
    try { connection.close(); } catch {}
  }

  _finishDrain() {
    if (this.drainResolve) this.drainResolve();
  }

  _rememberCompleted(key) {
    this.completed.add(key);
    if (this.completed.size > MAX_COMPLETED_KEYS) this.completed.delete(this.completed.values().next().value);
  }

  _nextItemId() {
    this.sequence += 1;
    return `deepgram-${this.channel}-${this.sequence}`;
  }

  _emitFinal(text, latencyMs = null) {
    const full = String(text || '').trim();
    if (!full) return;
    if (latencyMs != null) this.onLatency({ channel: this.channel, kind: 'final', latencyMs });
    this.onFinal({ channel: this.channel, itemId: this._nextItemId(), text: full, ts: Date.now() });
  }

  _handleMessage(event) {
    if (!event) return;
    if (event.type === 'Metadata') {
      this._finishDrain();
      return;
    }
    if (event.type === 'ConfigureFailure') {
      // ConfigureFailure is non-fatal by contract: the stream can continue, but
      // the user must still see that the requested option was rejected. Keep it
      // out of failureReported so a later fatal socket error can still surface.
      if (!this.configurationReported && !this.failureReported && !this.intentionalClose) {
        this.configurationReported = true;
        this.onError({
          code: 'realtime_configuration_failed',
          message: 'Deepgram rejected the stream configuration.',
          channel: this.channel,
        });
      }
      this._finishDrain();
      return;
    }
    if (event.type === 'Error') {
      // In-band server failures are reported through the shared classifier
      // (once per channel) instead of being thrown from the socket handler.
      this._reportError(sanitizeDeepgramError({
        code: event.code,
        type: event.type,
        message: event.message || event.description || event.type,
      }, this.channel));
      this._finishDrain();
      return;
    }
    if (event.type === 'UtteranceEnd') {
      // Deepgram emits a sentinel when it has no word timing to report.
      if (Number(event.last_word_end) === -1) return;
      this._flushCommitted();
      this._finishDrain();
      return;
    }
    if (event.type !== 'Results') return;
    const alternative = event.channel && Array.isArray(event.channel.alternatives)
      ? event.channel.alternatives[0]
      : null;
    const text = String((alternative && alternative.transcript) || '').trim();
    const startMs = Math.max(0, Math.round((Number(event.start) || 0) * 1000));
    const durationMs = Math.max(0, Math.round((Number(event.duration) || 0) * 1000));
    const latencyMs = Math.max(0, Math.round(this.audioSentMs - startMs - durationMs));
    // Boundaries are evaluated before the empty-text return: an empty
    // speech_final still ends the current utterance but must not merge two
    // utterances together.
    if (event.speech_final === true || event.from_finalize === true) {
      if (!text) {
        // An empty endpoint is still a boundary. Do not key it in `completed`:
        // a repeated empty boundary must not suppress the next real flush.
        this._flushCommitted();
      } else {
        const resultKey = `${startMs}:${durationMs}:${text}`;
        if (!this.completed.has(resultKey)) {
          this._rememberCompleted(resultKey);
          const full = `${this.committed || ''} ${text}`.trim();
          this.committed = '';
          this._emitFinal(full, latencyMs);
        }
      }
      // A natural speech_final can belong to earlier audio; only the finalize
      // response (or Metadata) proves CloseStream has nothing more to send.
      if (event.from_finalize === true) this._finishDrain();
      return;
    }
    if (!text) return;
    if (event.is_final === true) {
      const resultKey = `${startMs}:${durationMs}:${text}`;
      if (this.completed.has(resultKey)) return;
      this._rememberCompleted(resultKey);
      this._appendCommitted(text, latencyMs);
      this.onPartial({ channel: this.channel, itemId: this._nextItemId(), text: this.committed });
      return;
    }
    this.onLatency({ channel: this.channel, kind: 'first_partial', latencyMs });
    this.onPartial({ channel: this.channel, itemId: this._nextItemId(), text: `${this.committed || ''} ${text}`.trim() });
  }

  _appendCommitted(text, latencyMs) {
    const combined = `${this.committed || ''} ${text}`.trim();
    if (combined.length <= this.maxCommittedChars) {
      this.committed = combined;
      return;
    }
    // A stream that never endpoints must not grow without bound. Flush the
    // committed prefix, then keep the current segment (or flush it too when a
    // single result is already over the cap).
    const previous = (this.committed || '').trim();
    if (previous) this._emitFinal(previous, latencyMs);
    if (text.length > this.maxCommittedChars) {
      this.committed = '';
      this._emitFinal(text, latencyMs);
    } else {
      this.committed = text;
    }
  }

  _flushCommitted() {
    const full = (this.committed || '').trim();
    this.committed = '';
    this._emitFinal(full);
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

  // Called before the session asks for a final transcript on the way out, so
  // nothing that happens between the finalize and the close is treated as a fault.
  beginStop() {
    this.stopping = true;
  }

  _clearKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  _reportError(error) {
    if (this.failureReported || this.intentionalClose || this.stopping) return;
    this.failureReported = true;
    this.onError(error);
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_ENDPOINTING_MS,
  DEFAULT_UTTERANCE_END_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_MAX_COMMITTED_CHARS,
  MAX_KEYTERM_COUNT,
  MAX_KEYTERM_TOKENS,
  buildDeepgramOptions,
  sanitizeDeepgramError,
  DeepgramRealtimeChannel,
};
