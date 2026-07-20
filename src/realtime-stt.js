const { VoiceActivityDetector } = require('./voice-activity');
const { normalizeAzureEndpoint, normalizeTranscriptionLanguage } = require('./provider-config');
const { DeepgramRealtimeChannel } = require('./deepgram-realtime');

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

function buildRealtimeConnection({ provider = 'openai', endpoint, apiKey, model }) {
  if (provider === 'azure') {
    const normalized = normalizeAzureEndpoint(endpoint);
    const resource = new URL(normalized);
    return {
      url: `wss://${resource.host}/openai/v1/realtime?intent=transcription`,
      headers: { 'api-key': apiKey },
    };
  }
  if (provider !== 'openai') throw new Error(`Unsupported realtime provider: ${provider}`);
  return {
    url: `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`,
    headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'realtime=v1' },
  };
}

function cleanError(error, channel) {
  const candidate = [error && error.code, error && error.type, error && error.message]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');
  if (/(auth|api.?key|401|403)/.test(candidate)) {
    return { code: 'realtime_authentication_failed', message: 'Realtime transcription authentication failed.', channel };
  }
  if (candidate.includes('timeout')) {
    return { code: 'realtime_connection_timeout', message: 'Realtime transcription connection timed out.', channel };
  }
  if (/(network|socket|transport|connect|closed|backpressure|ws_)/.test(candidate)) {
    return { code: 'realtime_transport_failed', message: 'Realtime transcription connection failed.', channel };
  }
  if (/(audio|transcription)/.test(candidate)) {
    return { code: 'realtime_audio_failed', message: 'Realtime transcription could not process this audio segment.', channel };
  }
  return { code: 'realtime_failed', message: 'Realtime transcription failed.', channel };
}

class OpenAIRealtimeChannel {
  constructor({
    apiKey,
    channel,
    provider = 'openai',
    endpoint = null,
    model = 'gpt-realtime-whisper',
    language = '',
    delay = 'low',
    sampleRate = 24000,
    maxQueuedBytes = sampleRate * 2 * 3,
    maxBufferedBytes = sampleRate * 2 * 5,
    connectTimeoutMs = 10000,
    WebSocketImpl,
    onPartial = () => {},
    onFinal = () => {},
    onError = () => {},
    onItemFailure = () => {},
    onState = () => {},
    onLatency = () => {},
  }) {
    this.apiKey = apiKey;
    this.channel = channel;
    this.provider = provider;
    this.endpoint = endpoint;
    this.model = model;
    this.language = normalizeTranscriptionLanguage(language);
    this.delay = delay;
    this.sampleRate = sampleRate;
    this.maxQueuedBytes = maxQueuedBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.connectTimeoutMs = connectTimeoutMs;
    this.WebSocketImpl = WebSocketImpl || require('ws');
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.onError = onError;
    this.onItemFailure = onItemFailure;
    this.onState = onState;
    this.onLatency = onLatency;
    this.socket = null;
    this.queuedAudio = Buffer.alloc(0);
    this.commitAfterOpen = false;
    this.pendingAudioBytes = 0;
    this.partials = new Map();
    this.completed = new Set();
    this.commitTimestamps = [];
    this.itemTimestamps = new Map();
    this.firstPartialItems = new Set();
    this.intentionalClose = false;
    this.connectPromise = null;
    this.connectTimer = null;
    this.failureReported = false;
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    const { url, headers } = buildRealtimeConnection({
      provider: this.provider,
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      model: this.model,
    });

    this.onState({ channel: this.channel, state: 'connecting' });
    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const socket = new this.WebSocketImpl(url, { headers });
      this.apiKey = '';
      this.socket = socket;
      this.connectTimer = setTimeout(() => {
        if (settled) return;
        this.onState({ channel: this.channel, state: 'failed' });
        settled = true;
        const clean = cleanError({
          code: 'realtime_connect_timeout',
          message: 'Realtime transcription connection timed out.',
        }, this.channel);
        reject(new Error(clean.message));
        this._reportError(clean);
        this.close();
      }, this.connectTimeoutMs);

      socket.on('open', () => {
        this.onState({ channel: this.channel, state: 'connected' });
        this._clearConnectTimer();
        const transcription = { model: this.model };
        if (this.language) transcription.language = this.language;
        if (this.delay) transcription.delay = this.delay;
        this._send({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: this.sampleRate },
                transcription,
                turn_detection: null,
              },
            },
          },
        });
        if (this.queuedAudio.length) {
          const queued = this.queuedAudio;
          this.queuedAudio = Buffer.alloc(0);
          this._sendAudio(queued);
        }
        if (this.commitAfterOpen) {
          this.commitAfterOpen = false;
          this.commit();
        }
        settled = true;
        resolve();
      });

      socket.on('message', (data) => this._handleMessage(data));
      socket.on('error', (error) => {
        this.onState({ channel: this.channel, state: 'failed' });
        this._clearConnectTimer();
        const clean = cleanError(error, this.channel);
        this._reportError(clean);
        if (!settled) { settled = true; reject(new Error(clean.message)); }
      });
      socket.on('close', (code, reason) => {
        this.onState({ channel: this.channel, state: this.intentionalClose ? 'stopped' : 'disconnected' });
        this._clearConnectTimer();
        if (!settled) {
          settled = true;
          reject(new Error(this.intentionalClose
            ? 'Realtime transcription stopped before connecting.'
            : `Realtime transcription connection closed (${code}).`));
        }
        if (!this.intentionalClose) {
          this._reportError(cleanError({
            code: `ws_close_${code}`,
            message: `Realtime transcription connection closed${reason && reason.length ? `: ${reason.toString()}` : '.'}`,
          }, this.channel));
        }
      });
    });
    return this.connectPromise;
  }

  append(pcm) {
    const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    if (!buffer.length) return;
    if (this._isOpen()) {
      this._sendAudio(buffer);
      return;
    }
    this.queuedAudio = Buffer.concat([this.queuedAudio, buffer]);
    if (this.queuedAudio.length > this.maxQueuedBytes) {
      this.queuedAudio = this.queuedAudio.subarray(this.queuedAudio.length - this.maxQueuedBytes);
    }
  }

  commit() {
    if (!this._isOpen()) {
      if (this.queuedAudio.length) this.commitAfterOpen = true;
      return;
    }
    if (!this.pendingAudioBytes) return;
    this._send({ type: 'input_audio_buffer.commit' });
    this.commitTimestamps.push(Date.now());
    if (this.commitTimestamps.length > 100) this.commitTimestamps.shift();
    this.pendingAudioBytes = 0;
  }

  close() {
    this.intentionalClose = true;
    this._clearConnectTimer();
    this.queuedAudio = Buffer.alloc(0);
    this.commitAfterOpen = false;
    this.pendingAudioBytes = 0;
    this.partials.clear();
    this.commitTimestamps = [];
    this.itemTimestamps.clear();
    this.firstPartialItems.clear();
    if (this.socket && this.socket.readyState === this.WebSocketImpl.OPEN) {
      this.socket.close(1000, 'capture stopped');
    } else if (this.socket && typeof this.socket.terminate === 'function') {
      this.socket.terminate();
    } else if (this.socket && typeof this.socket.close === 'function') {
      try { this.socket.close(); } catch { /* connecting sockets may reject close */ }
    }
    this.socket = null;
  }

  _isOpen() {
    return !!this.socket && this.socket.readyState === this.WebSocketImpl.OPEN;
  }

  _send(event) {
    if (this._isOpen()) this.socket.send(JSON.stringify(event));
  }

  _sendAudio(buffer) {
    const bufferedAmount = Number((this.socket && this.socket.bufferedAmount) || 0);
    if (bufferedAmount + buffer.length > this.maxBufferedBytes) {
      this._reportError(cleanError({
        code: 'realtime_backpressure',
        message: 'Realtime transcription network buffer exceeded its safety limit.',
      }, this.channel));
      return false;
    }
    this._send({ type: 'input_audio_buffer.append', audio: buffer.toString('base64') });
    this.pendingAudioBytes += buffer.length;
    return true;
  }

  _handleMessage(data) {
    let event;
    try { event = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); }
    catch { return; }

    if (event.type === 'input_audio_buffer.committed' && event.item_id) {
      const ts = this.commitTimestamps.shift() || Date.now();
      if (this.itemTimestamps.size >= 100) this.itemTimestamps.delete(this.itemTimestamps.keys().next().value);
      this.itemTimestamps.set(event.item_id, ts);
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.delta' && event.item_id) {
      if (!this.firstPartialItems.has(event.item_id)) {
        this.firstPartialItems.add(event.item_id);
        if (this.firstPartialItems.size > 500) this.firstPartialItems.delete(this.firstPartialItems.values().next().value);
        const startedAt = this.itemTimestamps.get(event.item_id);
        if (startedAt) this.onLatency({ channel: this.channel, kind: 'first_partial', latencyMs: Date.now() - startedAt });
      }
      if (!this.partials.has(event.item_id) && this.partials.size >= 100) {
        this.partials.delete(this.partials.keys().next().value);
      }
      const text = (this.partials.get(event.item_id) || '') + (event.delta || '');
      this.partials.set(event.item_id, text);
      this.onPartial({ channel: this.channel, itemId: event.item_id, text });
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed' && event.item_id) {
      if (this.completed.has(event.item_id)) return;
      this.completed.add(event.item_id);
      if (this.completed.size > 500) this.completed.delete(this.completed.values().next().value);
      this.partials.delete(event.item_id);
      const text = String(event.transcript || '').trim();
      const startedAt = this.itemTimestamps.get(event.item_id);
      const ts = startedAt || this.commitTimestamps.shift() || Date.now();
      if (startedAt) this.onLatency({ channel: this.channel, kind: 'final', latencyMs: Date.now() - startedAt });
      this.itemTimestamps.delete(event.item_id);
      this.firstPartialItems.delete(event.item_id);
      if (text) this.onFinal({ channel: this.channel, itemId: event.item_id, text, ts });
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      const detail = event.error || {
        code: 'transcription_failed',
        message: event.message || 'Realtime transcription could not produce text for this audio item.',
      };
      if (event.item_id) {
        this.partials.delete(event.item_id);
        const hadTimestamp = this.itemTimestamps.delete(event.item_id);
        this.firstPartialItems.delete(event.item_id);
        if (!hadTimestamp) this.commitTimestamps.shift();
      } else {
        this.commitTimestamps.shift();
      }
      const clean = cleanError(detail, this.channel);
      this.onItemFailure({ ...clean, itemId: event.item_id || null });
      return;
    }

    if (event.type === 'error') this._reportError(cleanError(event.error, this.channel));
  }

  _clearConnectTimer() {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
  }

  _reportError(error) {
    if (this.failureReported || this.intentionalClose) return;
    this.failureReported = true;
    this.onError(error);
  }
}

class RealtimeTranscriptionManager {
  constructor({
    apiKey,
    provider = 'openai',
    endpoint = null,
    model = 'gpt-realtime-whisper',
    language = '',
    delay = 'low',
    sampleRate = 24000,
    vad = {},
    preRollMs = 250,
    fallbackCommitMs = 2500,
    fallbackThresholdRatio = 0.45,
    azureCommitMs = 3000,
    enabledChannels = ['you', 'them'],
    WebSocketImpl,
    DeepgramClientImpl,
    onPartial = () => {},
    onFinal = () => {},
    onError = () => {},
    onState = () => {},
    onLatency = () => {},
  }) {
    this.failed = false;
    this.closed = false;
    this.closeTimer = null;
    this.stopPromise = null;
    this.resolveStop = null;
    this.onError = onError;
    this.onState = onState;
    this.onLatency = onLatency;
    this.provider = provider;
    this.sampleRate = sampleRate;
    this.enabledChannels = [...new Set((Array.isArray(enabledChannels) ? enabledChannels : []).filter((channel) => ['you', 'them'].includes(channel)))];
    if (!this.enabledChannels.length) this.enabledChannels.push('you');
    this.azureCommitMs = Math.max(500, Math.min(10000, Number(azureCommitMs) || 3000));
    this.azureStreams = {
      you: { durationMs: 0, maxLevel: 0 },
      them: { durationMs: 0, maxLevel: 0 },
    };
    this.channels = {};
    this.vads = {};
    this.preRoll = { you: Buffer.alloc(0), them: Buffer.alloc(0) };
    this.preRollMaxBytes = Math.max(0, Math.floor(sampleRate * 2 * preRollMs / 1000));
    this.fallbackCommitMs = Math.max(1000, Math.min(5000, Number(fallbackCommitMs) || 2500));
    this.fallbackThresholdRatio = Math.max(0.2, Math.min(0.8, Number(fallbackThresholdRatio) || 0.45));
    this.fallbackCandidates = {
      you: { buffer: Buffer.alloc(0), durationMs: 0, maxLevel: 0 },
      them: { buffer: Buffer.alloc(0), durationMs: 0, maxLevel: 0 },
    };
    this.channelStates = Object.fromEntries(this.enabledChannels.map((channel) => [channel, 'idle']));
    for (const channel of this.enabledChannels) {
      this.vads[channel] = new VoiceActivityDetector({ sampleRate, ...vad });
      const ChannelImpl = provider === 'deepgram' ? DeepgramRealtimeChannel : OpenAIRealtimeChannel;
      this.channels[channel] = new ChannelImpl({
        apiKey,
        channel,
        provider,
        endpoint,
        model,
        language,
        delay,
        sampleRate,
        WebSocketImpl,
        DeepgramClientImpl,
        onPartial,
        onFinal,
        onError: (error) => this._fail(error),
        onItemFailure: (failure) => this.onState({ mode: 'realtime', status: 'item_failed', ...failure }),
        onState: (event) => this._channelState(event),
        onLatency: (event) => this.onLatency(event),
      });
    }
  }

  async start() {
    this.onState({ mode: 'realtime', status: 'connecting' });
    await Promise.all(Object.values(this.channels).map((channel) => channel.connect()));
    if (!this.failed) this.onState({ mode: 'realtime', status: 'connected' });
  }

  append(channelName, pcm) {
    if (this.failed || !this.channels[channelName]) return false;
    const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    if (!buffer.length) return true;
    if (this.provider === 'azure') return this._appendAzure(channelName, buffer);
    if (this.provider === 'deepgram') return this._appendDeepgram(channelName, buffer);
    const wasActive = this.vads[channelName].active;
    const durationMs = (buffer.length / 2 / this.vads[channelName].sampleRate) * 1000;
    const fallback = this.fallbackCandidates[channelName];
    if (!wasActive) {
      if (this.preRollMaxBytes > 0) {
        this.preRoll[channelName] = Buffer.concat([this.preRoll[channelName], buffer]);
        if (this.preRoll[channelName].length > this.preRollMaxBytes) {
          this.preRoll[channelName] = this.preRoll[channelName].subarray(this.preRoll[channelName].length - this.preRollMaxBytes);
        }
      }
      fallback.buffer = Buffer.concat([fallback.buffer, buffer]);
      const fallbackMaxBytes = Math.ceil(this.vads[channelName].sampleRate * 2 * this.fallbackCommitMs / 1000);
      if (fallback.buffer.length > fallbackMaxBytes) fallback.buffer = fallback.buffer.subarray(fallback.buffer.length - fallbackMaxBytes);
      fallback.durationMs += durationMs;
    }
    const result = this.vads[channelName].push(buffer);
    if (!wasActive) fallback.maxLevel = Math.max(fallback.maxLevel, result.level);
    if (result.speechStarted) {
      this.channels[channelName].append(this.preRoll[channelName]);
      this.preRoll[channelName] = Buffer.alloc(0);
      this._resetFallback(channelName);
      this.onState({ mode: 'realtime', status: 'activity', channel: channelName, activity: 'speech' });
    } else if (result.active || result.speechStopped) {
      this.channels[channelName].append(buffer);
    }
    if (result.speechStopped) {
      this.channels[channelName].commit();
      this.onState({ mode: 'realtime', status: 'activity', channel: channelName, activity: 'processing' });
    } else if (!result.active && fallback.durationMs >= this.fallbackCommitMs) {
      if (this._fallbackEligible(channelName)) {
        this._flushFallback(channelName);
        this.preRoll[channelName] = Buffer.alloc(0);
        this.onState({ mode: 'realtime', status: 'activity', channel: channelName, activity: 'processing', fallback: true });
      }
      this._resetFallback(channelName);
    }
    return true;
  }

  _appendAzure(channelName, buffer) {
    const stream = this.azureStreams[channelName];
    const result = this.vads[channelName].push(buffer);
    this.channels[channelName].append(buffer);
    stream.durationMs += (buffer.length / 2 / this.sampleRate) * 1000;
    stream.maxLevel = Math.max(stream.maxLevel, result.level);
    if (result.speechStarted) {
      this.onState({ mode: 'realtime', status: 'activity', channel: channelName, activity: 'speech' });
    }
    if (stream.durationMs >= this.azureCommitMs) {
      this.channels[channelName].commit();
      stream.durationMs = 0;
      stream.maxLevel = 0;
      this.onState({ mode: 'realtime', status: 'activity', channel: channelName, activity: 'processing', fixedWindow: true });
    }
    return true;
  }

  _appendDeepgram(channelName, buffer) {
    const result = this.vads[channelName].push(buffer);
    const accepted = this.channels[channelName].append(buffer);
    if (result.speechStarted) {
      this.onState({ mode: 'realtime', status: 'activity', channel: channelName, activity: 'speech' });
    }
    if (result.speechStopped) {
      this.onState({ mode: 'realtime', status: 'activity', channel: channelName, activity: 'processing' });
    }
    return accepted;
  }

  _fallbackEligible(channelName) {
    const vad = this.vads[channelName];
    const fallback = this.fallbackCandidates[channelName];
    const startThreshold = Math.max(vad.threshold, vad.noiseFloor * vad.noiseMultiplier);
    const fallbackThreshold = Math.max(30, startThreshold * this.fallbackThresholdRatio);
    return !!fallback.buffer.length && fallback.maxLevel >= fallbackThreshold;
  }

  _flushFallback(channelName) {
    const fallback = this.fallbackCandidates[channelName];
    this.channels[channelName].append(fallback.buffer);
    this.channels[channelName].commit();
  }

  _resetFallback(channelName) {
    this.fallbackCandidates[channelName] = { buffer: Buffer.alloc(0), durationMs: 0, maxLevel: 0 };
  }

  stop({ graceMs = 0, flushFallback } = {}) {
    if (this.closed) return Promise.resolve();
    if (!this.stopPromise) {
      this.stopPromise = new Promise((resolve) => { this.resolveStop = resolve; });
    }
    const shouldFlushFallback = flushFallback == null ? graceMs > 0 : !!flushFallback;
    for (const channel of Object.keys(this.channels)) {
      if (this.provider === 'deepgram') {
        this.channels[channel].commit();
      } else if (this.provider === 'azure') {
        const stream = this.azureStreams[channel];
        if (shouldFlushFallback && stream.durationMs >= 500 && stream.maxLevel >= 30) {
          this.channels[channel].commit();
          this.onState({ mode: 'realtime', status: 'activity', channel, activity: 'processing', fixedWindow: true });
        }
        stream.durationMs = 0;
        stream.maxLevel = 0;
      } else if (this.vads[channel].active) {
        this.channels[channel].commit();
      } else if (shouldFlushFallback && this._fallbackEligible(channel)) {
        this._flushFallback(channel);
        this.onState({ mode: 'realtime', status: 'activity', channel, activity: 'processing', fallback: true });
      }
      this.vads[channel].reset();
      this.preRoll[channel] = Buffer.alloc(0);
      this._resetFallback(channel);
    }
    const close = () => {
      if (this.closed) return;
      this.closed = true;
      this.closeTimer = null;
      for (const channel of Object.values(this.channels)) channel.close();
      this.onState({ mode: 'realtime', status: 'stopped' });
      if (this.resolveStop) { this.resolveStop(); this.resolveStop = null; }
    };
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (graceMs > 0) this.closeTimer = setTimeout(close, graceMs);
    else close();
    return this.stopPromise;
  }

  _fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.closed = true;
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    for (const channel of Object.values(this.channels)) channel.close();
    if (this.resolveStop) { this.resolveStop(); this.resolveStop = null; }
    this.onError(error);
    this.onState({ mode: 'realtime', status: 'failed' });
  }

  _channelState(event) {
    this.channelStates[event.channel] = event.state;
    const connectedChannels = Object.values(this.channelStates).filter((state) => state === 'connected').length;
    this.onState({ mode: 'realtime', status: 'channel', channel: event.channel, channelState: event.state, connectedChannels, totalChannels: this.enabledChannels.length });
  }
}

module.exports = { OpenAIRealtimeChannel, RealtimeTranscriptionManager, OPENAI_REALTIME_URL, buildRealtimeConnection };
