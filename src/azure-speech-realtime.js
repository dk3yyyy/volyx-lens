'use strict';

const crypto = require('crypto');
const { normalizeTranscriptionLanguage, normalizeAzureSpeechRegion } = require('./provider-config');
const { classifyRealtimeError } = require('./realtime-errors');

// Azure AI Speech realtime STT is a raw WebSocket protocol that is unrelated to
// the OpenAI Realtime protocol used by the other channels. It speaks in
// header-prefixed text messages (speech.config / speech.hypothesis /
// speech.phrase / speech.endpointDetected / turn.end) and binary audio frames.
// The Speech service performs its own endpoint detection, so the channel does
// not need commit() to force recognition; it only streams audio continuously.

const STT_BASE_HOST = '.stt.speech.microsoft.com';
const STT_CONVERSATION_PATH = '/speech/recognition/conversation/cognitiveservices/v1';
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const MAX_CONNECTED_BUFFER_BYTES = 24 * 1024;

function newRequestId() {
  return crypto.randomUUID().replace(/-/g, '');
}

// The recognition locale for the conversation endpoint. An empty language asks
// the service to auto-detect the spoken language.
function recognitionLocale(language) {
  const normalized = normalizeTranscriptionLanguage(language);
  return normalized || 'auto';
}

function buildAzureSpeechUrl({ region, language = '', sampleRate = 24000 }) {
  const host = `wss://${normalizeAzureSpeechRegion(region)}${STT_BASE_HOST}${STT_CONVERSATION_PATH}`;
  const params = new URLSearchParams({
    format: 'simple',
    language: recognitionLocale(language),
    profanity: 'masked',
    'X-SampleRate': String(sampleRate),
  });
  return `${host}?${params.toString()}`;
}

function speechConfigBody(phrases = []) {
  const context = {
    system: {
      name: 'VolyxLens',
      version: '1.0.0',
      lang: 'en-US',
    },
  };
  if (Array.isArray(phrases) && phrases.length) {
    context.service = { recognition: { speechContext: { phrases: phrases.slice(0, 50) } } };
  }
  return JSON.stringify({ context });
}

function buildSpeechConfigMessage({ phrases = [], requestId, timestamp }) {
  const headers = [
    'path:speech.config',
    `x-requestid:${requestId}`,
    `x-timestamp:${timestamp}`,
    'content-type:application/json; charset=utf-8',
    '',
    '',
  ].join('\r\n');
  return `${headers}${speechConfigBody(phrases)}`;
}

// Binary audio messages are framed as a 2-byte big-endian header length, the
// ASCII header block, then the raw PCM bytes.
function buildAudioMessage(pcm, { requestId, timestamp, sampleRate }) {
  const header = [
    'path:audio',
    `x-requestid:${requestId}`,
    `x-timestamp:${timestamp}`,
    `content-type:audio/L16; rate=${sampleRate}`,
  ].join('\r\n');
  const headerBytes = Buffer.byteLength(header, 'ascii');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(headerBytes, 0);
  return Buffer.concat([head, Buffer.from(header, 'ascii'), Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || [])]);
}

// Parse an inbound text message into { path, body } where body is the JSON
// payload after the blank line separator. Header names are matched
// case-insensitively; 'path' is expected on the first header line.
function parseAzureSpeechMessage(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const separator = text.indexOf('\r\n\r\n');
  const head = separator === -1 ? text : text.slice(0, separator);
  const bodyText = separator === -1 ? '' : text.slice(separator + 4);
  let path = '';
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key === 'path') { path = line.slice(colon + 1).trim(); break; }
  }
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = null; }
  return { path, body, raw: text };
}

const cleanAzureSpeechError = (error, channel) => classifyRealtimeError(error, channel, {
  providerLabel: 'Azure AI Speech',
  includeRateLimit: true,
});

class AzureSpeechRealtimeChannel {
  constructor({
    apiKey,
    channel,
    region = '',
    language = '',
    phrases = [],
    sampleRate = 24000,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    maxQueuedBytes = sampleRate * 2 * 3,
    maxBufferedBytes = MAX_CONNECTED_BUFFER_BYTES,
    WebSocketImpl,
    onPartial = () => {},
    onFinal = () => {},
    onError = () => {},
    onState = () => {},
    onLatency = () => {},
  }) {
    this.apiKey = String(apiKey || '');
    this.channel = channel;
    this.region = String(region || '').trim().toLowerCase();
    this.language = language;
    this.phrases = Array.isArray(phrases) ? phrases : [];
    this.sampleRate = sampleRate;
    this.connectTimeoutMs = connectTimeoutMs;
    this.maxQueuedBytes = maxQueuedBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.WebSocketImpl = WebSocketImpl || require('ws');
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.onError = onError;
    this.onState = onState;
    this.onLatency = onLatency;
    this.socket = null;
    this.connectionId = newRequestId();
    this.connectPromise = null;
    this.connectTimer = null;
    this.queuedAudio = Buffer.alloc(0);
    this.pendingAudioBytes = 0;
    this.completed = new Set();
    this.lastFinalText = '';
    this.itemSequence = 0;
    this.partialCount = 0;
    this.firstPartialAtMs = 0;
    this.audioSentMs = 0;
    this.intentionalClose = false;
    this.failureReported = false;
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    const url = buildAzureSpeechUrl({
      region: this.region,
      language: this.language,
      sampleRate: this.sampleRate,
    });
    this.onState({ channel: this.channel, state: 'connecting' });
    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const socket = new this.WebSocketImpl(url, {
        headers: {
          'Ocp-Apim-Subscription-Key': this.apiKey,
          'X-ConnectionId': this.connectionId,
        },
      });
      this.apiKey = '';
      this.socket = socket;
      this.connectTimer = setTimeout(() => {
        if (settled) return;
        this.onState({ channel: this.channel, state: 'failed' });
        settled = true;
        const clean = cleanAzureSpeechError({
          code: 'realtime_connect_timeout',
          message: 'Azure AI Speech connection timed out.',
        }, this.channel);
        reject(new Error(clean.message));
        this._reportError(clean);
        this.close();
      }, this.connectTimeoutMs);

      socket.on('open', () => {
        this._clearConnectTimer();
        this._sendText(buildSpeechConfigMessage({
          phrases: this.phrases,
          requestId: newRequestId(),
          timestamp: new Date().toISOString(),
        }));
        this.onState({ channel: this.channel, state: 'connected' });
        if (this.queuedAudio.length) {
          const queued = this.queuedAudio;
          this.queuedAudio = Buffer.alloc(0);
          this.pendingAudioBytes = 0;
          this._sendAudio(queued);
        }
        settled = true;
        resolve();
      });

      socket.on('message', (data) => this._handleMessage(data));
      socket.on('error', (error) => {
        this.onState({ channel: this.channel, state: 'failed' });
        this._clearConnectTimer();
        const clean = cleanAzureSpeechError(error, this.channel);
        this._reportError(clean);
        if (!settled) { settled = true; reject(new Error(clean.message)); }
      });
      socket.on('close', (code, reason) => {
        this._clearConnectTimer();
        this.onState({ channel: this.channel, state: this.intentionalClose ? 'stopped' : 'disconnected' });
        if (!settled) {
          settled = true;
          reject(new Error(this.intentionalClose
            ? 'Azure AI Speech stopped before connecting.'
            : `Azure AI Speech connection closed (${code}).`));
        }
        if (!this.intentionalClose) {
          this._reportError(cleanAzureSpeechError({
            code: `ws_close_${code}`,
            message: `Azure AI Speech connection closed${reason && reason.length ? `: ${reason.toString()}` : '.'}`,
          }, this.channel));
        }
      });
    });
    return this.connectPromise;
  }

  append(pcm) {
    const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    if (!buffer.length || this.intentionalClose) return false;
    if (this._isOpen()) {
      return this._sendAudio(buffer);
    }
    if (this.pendingAudioBytes + buffer.length > this.maxQueuedBytes) {
      this._reportError(cleanAzureSpeechError({
        code: 'realtime_transport_failed',
        message: 'Azure AI Speech pre-connect buffer exceeded its safety maximum.',
      }, this.channel));
      return false;
    }
    this.queuedAudio = Buffer.concat([this.queuedAudio, buffer]);
    this.pendingAudioBytes += buffer.length;
    return true;
  }

  // Azure Speech performs its own endpoint detection server-side; there is no
  // commit signal. Kept as a no-op to satisfy the shared channel contract.
  commit() {}

  close() {
    this.intentionalClose = true;
    this._clearConnectTimer();
    this.queuedAudio = Buffer.alloc(0);
    this.pendingAudioBytes = 0;
    this.completed.clear();
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

  _sendText(text) {
    if (this._isOpen()) this.socket.send(text);
  }

  _sendAudio(buffer) {
    const bufferedAmount = Number((this.socket && this.socket.bufferedAmount) || 0);
    if (bufferedAmount + buffer.length > this.maxBufferedBytes) {
      this._reportError(cleanAzureSpeechError({
        code: 'realtime_backpressure',
        message: 'Azure AI Speech network buffer exceeded its safety maximum.',
      }, this.channel));
      return false;
    }
    const frame = buildAudioMessage(buffer, {
      requestId: newRequestId(),
      timestamp: new Date().toISOString(),
      sampleRate: this.sampleRate,
    });
    this.socket.send(frame);
    this.pendingAudioBytes += buffer.length;
    this.audioSentMs += (buffer.length / 2 / this.sampleRate) * 1000;
    return true;
  }

  _handleMessage(data) {
    const message = parseAzureSpeechMessage(data);
    if (!message.path) return;
    switch (message.path.toLowerCase()) {
      case 'speech.hypothesis': {
        const text = String((message.body && message.body.Text) || '').trim();
        if (!text) return;
        this.partialCount += 1;
        if (this.partialCount === 1) {
          this.firstPartialAtMs = Date.now();
        }
        this.onPartial({ channel: this.channel, itemId: `azure-speech-${this.channel}-partial-${this.partialCount}`, text });
        return;
      }
      case 'speech.phrase': {
        const status = String((message.body && message.body.RecognitionStatus) || '').trim();
        const text = String((message.body && (message.body.DisplayText || message.body.Text)) || '').trim();
        if (status !== 'Success' || !text) return;
        if (text === this.lastFinalText) return;
        this.lastFinalText = text;
        const startedAt = this.firstPartialAtMs || Date.now();
        this.partialCount = 0;
        this.firstPartialAtMs = 0;
        this.itemSequence += 1;
        const itemId = `azure-speech-${this.channel}-${this.itemSequence}`;
        if (this.completed.has(itemId)) return;
        this.completed.add(itemId);
        if (this.completed.size > 500) this.completed.delete(this.completed.values().next().value);
        this.onLatency({ channel: this.channel, kind: 'final', latencyMs: Date.now() - startedAt });
        this.onFinal({ channel: this.channel, itemId, text, ts: Date.now() });
        return;
      }
      case 'speech.endpointDetected':
      case 'turn.end':
        this.partialCount = 0;
        this.firstPartialAtMs = 0;
        this.lastFinalText = '';
        return;
      case 'speech.config':
      case 'speech.connectionClosed':
      case 'turn.start':
      case 'speech.startDetected':
      case 'speech.endDetected':
        return;
      default:
        if (message.path.toLowerCase().includes('error')) {
          this._reportError(cleanAzureSpeechError(message.body || message, this.channel));
        }
    }
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

module.exports = {
  STT_BASE_HOST,
  STT_CONVERSATION_PATH,
  DEFAULT_CONNECT_TIMEOUT_MS,
  buildAzureSpeechUrl,
  buildSpeechConfigMessage,
  buildAudioMessage,
  parseAzureSpeechMessage,
  recognitionLocale,
  cleanAzureSpeechError,
  AzureSpeechRealtimeChannel,
};