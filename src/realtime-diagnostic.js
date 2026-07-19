const WebSocket = require('ws');
const { resolveRealtimeTranscription, normalizeTranscriptionLanguage } = require('./provider-config');
const { buildRealtimeConnection, RealtimeTranscriptionManager } = require('./realtime-stt');
const { DeepgramRealtimeChannel } = require('./deepgram-realtime');
const { AUDIO_SAMPLE_RATE } = require('./audio-config');

function redact(value, secrets = []) {
  let text = String(value || 'Realtime diagnostic failed.');
  for (const secret of secrets) {
    if (secret) text = text.split(String(secret)).join('[REDACTED]');
  }
  return text.replace(/(api[-_ ]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]');
}

function httpFailure(status) {
  const messages = {
    401: 'Authentication failed. The API key does not match this Azure/OpenAI endpoint.',
    403: 'Access denied. Check model access, region availability, quota, and resource permissions.',
    404: 'Realtime route or deployment was not found. Check the endpoint and exact deployment name.',
    408: 'The provider timed out while opening the Realtime session.',
    429: 'Rate limit or quota exceeded for the Realtime deployment.',
  };
  return {
    ok: false,
    stage: 'http',
    status,
    code: `http_${status || 'error'}`,
    message: messages[status] || `Realtime endpoint returned HTTP ${status || 'error'}.`,
  };
}

function runRealtimeDiagnostic({ settings, WebSocketImpl = WebSocket, DeepgramClientImpl, timeoutMs = 12000 } = {}) {
  const startedAt = Date.now();
  const safeSettings = settings || {};
  const resolved = resolveRealtimeTranscription(safeSettings);
  const base = {
    provider: resolved.provider,
    deployment: resolved.model || '',
  };

  if (!resolved.ready) {
    return Promise.resolve({
      ...base,
      ok: false,
      stage: 'configuration',
      code: 'not_configured',
      message: resolved.configurationError,
      elapsedMs: Date.now() - startedAt,
    });
  }

  if (resolved.provider === 'deepgram') {
    const channel = new DeepgramRealtimeChannel({
      apiKey: resolved.apiKey,
      channel: 'you',
      model: resolved.model,
      language: normalizeTranscriptionLanguage(safeSettings.transcription?.language),
      sampleRate: AUDIO_SAMPLE_RATE,
      connectTimeoutMs: timeoutMs,
      DeepgramClientImpl,
    });
    return channel.connect()
      .then(() => ({
        ...base,
        ok: true,
        stage: 'session',
        code: 'session_accepted',
        message: 'Deepgram endpoint, authentication, model, and streaming settings were accepted.',
        elapsedMs: Date.now() - startedAt,
      }))
      .catch((error) => ({
        ...base,
        ok: false,
        stage: 'connection',
        code: 'connection_failed',
        message: redact(error.message, [resolved.apiKey]),
        elapsedMs: Date.now() - startedAt,
      }))
      .finally(() => channel.close());
  }

  let connection;
  try {
    connection = buildRealtimeConnection(resolved);
  } catch (error) {
    return Promise.resolve({
      ...base,
      ok: false,
      stage: 'configuration',
      code: 'invalid_endpoint',
      message: redact(error.message, [resolved.apiKey]),
      elapsedMs: Date.now() - startedAt,
    });
  }

  const language = normalizeTranscriptionLanguage(safeSettings.transcription?.language);
  const delay = safeSettings.transcription?.delay || 'low';

  return new Promise((resolve) => {
    let socket;
    let settled = false;
    let opened = false;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket && (socket.readyState === WebSocketImpl.OPEN || socket.readyState === WebSocketImpl.CONNECTING)) {
        try { socket.close(1000, 'diagnostic complete'); } catch { try { socket.terminate(); } catch {} }
      }
      resolve({ ...base, ...result, elapsedMs: Date.now() - startedAt });
    };

    try {
      socket = new WebSocketImpl(connection.url, { headers: connection.headers });
    } catch (error) {
      finish({
        ok: false,
        stage: 'connection',
        code: 'socket_create_failed',
        message: redact(error.message, [resolved.apiKey]),
      });
      return;
    }

    timer = setTimeout(() => finish({
      ok: false,
      stage: opened ? 'session' : 'connection',
      code: 'diagnostic_timeout',
      message: opened
        ? 'Connected, but the provider did not accept the transcription session before timeout.'
        : 'Could not connect to the Realtime endpoint before timeout.',
    }), timeoutMs);

    socket.on('open', () => {
      opened = true;
      const transcription = { model: resolved.model };
      if (language) transcription.language = language;
      if (delay) transcription.delay = delay;
      socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: AUDIO_SAMPLE_RATE },
              transcription,
              turn_detection: null,
            },
          },
        },
      }));
    });

    socket.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      if (event.type === 'session.updated') {
        finish({
          ok: true,
          stage: 'session',
          code: 'session_accepted',
          message: 'Realtime endpoint, authentication, deployment, and transcription settings were accepted.',
        });
        return;
      }
      if (event.type === 'error') {
        const error = event.error || {};
        finish({
          ok: false,
          stage: 'session',
          status: Number(error.status) || undefined,
          code: String(error.code || 'provider_error'),
          message: redact(error.message || 'The provider rejected the transcription session.', [resolved.apiKey]),
        });
      }
    });

    socket.on('unexpected-response', (_request, response) => finish(httpFailure(response && response.statusCode)));
    socket.on('error', (error) => finish({
      ok: false,
      stage: opened ? 'session' : 'connection',
      code: error.code || 'socket_error',
      message: redact(error.message || 'Realtime WebSocket connection failed.', [resolved.apiKey]),
    }));
    socket.on('close', (code) => {
      if (!settled) finish({
        ok: false,
        stage: opened ? 'session' : 'connection',
        code: `socket_closed_${code}`,
        message: opened
          ? 'The provider closed the connection before accepting the transcription session.'
          : 'The Realtime connection closed before it opened.',
      });
    });
  });
}

class LiveRealtimeDiagnostic {
  constructor({ settings, ManagerImpl = RealtimeTranscriptionManager, WebSocketImpl = WebSocket, DeepgramClientImpl } = {}) {
    this.settings = settings || {};
    this.ManagerImpl = ManagerImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.DeepgramClientImpl = DeepgramClientImpl;
    this.manager = null;
    this.started = false;
    this.finished = false;
    this.transcripts = [];
    this.error = null;
    this.itemFailure = null;
    this.bytesSent = 0;
    this.chunksSent = 0;
    this.commitCount = 0;
    this.maxLevel = 0;
    this.sourceSampleRate = null;
    this.resolved = resolveRealtimeTranscription(this.settings);
    this.startedAt = Date.now();
    try {
      const connection = this.resolved.ready && this.resolved.provider !== 'deepgram' ? buildRealtimeConnection(this.resolved) : null;
      this.endpointHost = this.resolved.provider === 'deepgram' ? 'api.deepgram.com' : (connection ? new URL(connection.url).hostname : '');
    } catch { this.endpointHost = ''; }
  }

  base() {
    return {
      provider: this.resolved.provider,
      deployment: this.resolved.model || '',
      endpointHost: this.endpointHost,
    };
  }

  async start() {
    if (!this.resolved.ready) {
      return { ...this.base(), ok: false, stage: 'configuration', code: 'not_configured', message: this.resolved.configurationError };
    }
    const transcription = this.settings.transcription || {};
    const audio = this.settings.audio || {};
    this.manager = new this.ManagerImpl({
      apiKey: this.resolved.apiKey,
      provider: this.resolved.provider,
      endpoint: this.resolved.endpoint,
      model: this.resolved.model,
      language: transcription.language || '',
      delay: transcription.delay || 'low',
      sampleRate: AUDIO_SAMPLE_RATE,
      enabledChannels: ['you'],
      WebSocketImpl: this.WebSocketImpl,
      DeepgramClientImpl: this.DeepgramClientImpl,
      onFinal: (event) => {
        const text = String(event && event.text || '').trim().slice(0, 4000);
        if (text && !this.transcripts.includes(text) && this.transcripts.length < 10) this.transcripts.push(text);
      },
      onState: (event) => {
        if (event && event.status === 'activity' && event.activity === 'processing') this.commitCount += 1;
        if (event && event.status === 'item_failed') this.itemFailure = event;
      },
      onError: (error) => { this.error = error || new Error('Realtime transcription failed.'); },
      vad: {
        threshold: ({ quiet: 80, balanced: 160, noisy: 300 })[audio.sensitivity] || 160,
        silenceMs: Math.max(300, Math.min(2000, Number(audio.silenceMs) || 700)),
        maxUtteranceMs: 20000,
      },
      preRollMs: Math.max(0, Math.min(1000, Number(audio.preRollMs) || 250)),
    });
    try {
      await this.manager.start();
      this.started = true;
      return { ...this.base(), ok: true, stage: 'capture', code: 'ready', message: 'Realtime session connected. Speak for five seconds.' };
    } catch (error) {
      this.error = error;
      return { ...this.base(), ok: false, stage: 'connection', code: error.code || 'connection_failed', message: redact(error.message, [this.resolved.apiKey]) };
    }
  }

  append(pcm, metadata = {}) {
    if (!this.started || this.finished || !this.manager) return false;
    const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    if (!buffer.length || buffer.length > 256 * 1024) return false;
    const maximumBytes = AUDIO_SAMPLE_RATE * 2 * 10;
    if (this.bytesSent + buffer.length > maximumBytes) return false;
    this.sourceSampleRate = Math.max(8000, Math.min(192000, Number(metadata.sourceSampleRate) || this.sourceSampleRate || AUDIO_SAMPLE_RATE));
    this.maxLevel = Math.max(this.maxLevel, Math.max(0, Math.min(1, Number(metadata.level) || 0)));
    this.bytesSent += buffer.length;
    this.chunksSent += 1;
    return this.manager.append('you', buffer);
  }

  async finish() {
    if (this.finished) return { ...this.base(), ok: false, stage: 'capture', code: 'already_finished', message: 'The live diagnostic has already finished.' };
    this.finished = true;
    const durationMs = Math.round(this.bytesSent / 2 / AUDIO_SAMPLE_RATE * 1000);
    if (this.manager) await this.manager.stop({ graceMs: 2500, flushFallback: true });
    const telemetry = {
      sourceSampleRate: this.sourceSampleRate || AUDIO_SAMPLE_RATE,
      targetSampleRate: AUDIO_SAMPLE_RATE,
      bytesSent: this.bytesSent,
      chunksSent: this.chunksSent,
      durationMs,
      commitCount: this.commitCount,
      maxLevel: Math.round(this.maxLevel * 1000) / 1000,
    };
    if (durationMs < 1000) {
      return { ...this.base(), ...telemetry, ok: false, stage: 'capture', code: 'insufficient_audio', message: 'Less than one second of microphone audio reached the diagnostic.' };
    }
    if (this.error) {
      return { ...this.base(), ...telemetry, ok: false, stage: 'transcription', code: this.error.code || 'provider_error', message: redact(this.error.message, [this.resolved.apiKey]) };
    }
    const transcript = this.transcripts.join(' ').trim();
    if (!transcript) {
      const detail = this.itemFailure && this.itemFailure.message ? ` ${this.itemFailure.message}` : '';
      return { ...this.base(), ...telemetry, ok: false, stage: 'transcription', code: 'no_transcript', message: `Audio reached the provider, but no transcript was returned.${detail}`.trim() };
    }
    return { ...this.base(), ...telemetry, ok: true, stage: 'transcription', code: 'transcript_received', message: 'Live microphone transcription succeeded.', transcript };
  }

  cancel() {
    this.finished = true;
    if (this.manager) this.manager.stop();
  }
}

module.exports = { runRealtimeDiagnostic, LiveRealtimeDiagnostic, redact, httpFailure };
