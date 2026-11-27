'use strict';

const { VoiceActivityDetector } = require('./voice-activity');

const MAX_RECOVERY_CHUNKS = 1200;
// 120 s of 24 kHz mono 16-bit PCM. Accepting more undelivered audio than this
// is refused rather than silently trimming the oldest speech.
const MAX_RECOVERY_BYTES = 120 * 24_000 * 2;
const BYTES_PER_SECOND = 24_000 * 2;
const DEFAULT_LEASE_MS = 10_000;
const DEFAULT_MAX_BACKLOG_SECONDS = 120;
const DEFAULT_FINISH_DEADLINE_MS = 3_000;
// The worker keeps one growing window until a boundary arrives. Continuous
// speech (no VAD stop) would therefore never finalize, so the manager cuts a
// window at this length even while the speaker keeps talking.
const DEFAULT_MAX_WINDOW_MS = 25_000;

function createLocalSpeechStreamManager({
  worker,
  modelId,
  channels = ['you', 'them'],
  language = '',
  vocabulary = [],
  backend = 'auto',
  maxInFlight = 4,
  vad = {},
  maxWindowMs = DEFAULT_MAX_WINDOW_MS,
  leaseMs = DEFAULT_LEASE_MS,
  maxBacklogSeconds = DEFAULT_MAX_BACKLOG_SECONDS,
  finishDeadlineMs = DEFAULT_FINISH_DEADLINE_MS,
  onPartial = () => {},
  onFinal = () => {},
  onState = () => {},
  onError = () => {},
} = {}) {
  if (!worker || typeof worker.streamStart !== 'function'
      || typeof worker.streamFeed !== 'function' || typeof worker.streamBoundary !== 'function') {
    throw new TypeError('A streaming speech worker is required.');
  }
  const activeChannels = [...new Set(channels)].filter((channel) => channel === 'you' || channel === 'them');
  if (!activeChannels.length) throw new TypeError('At least one valid speech channel is required.');

  const inFlight = new Map(activeChannels.map((channel) => [channel, 0]));
  // `boundaries` is a FIFO of absolute chunk positions, one per VAD stop.
  // `offset` counts chunks discarded from the front (by trimming or by an
  // earlier final) so a queued boundary written before that discard still
  // resolves to the right chunk. A scalar was not enough: a second boundary
  // before the first final overwrote it and the fallback splice dropped the
  // next utterance.
  const recovery = new Map(activeChannels.map((channel) => [channel, {
    chunks: [],
    bytes: 0,
    offset: 0,
    boundaries: [],
  }]));
  const vads = new Map(activeChannels.map((channel) => [
    channel,
    new VoiceActivityDetector({ sampleRate: 24_000, ...vad }),
  ]));
  let ready = false;
  let stopped = false;
  let failureNotified = false;
  let startPromise = null;
  let stopPromise = null;
  const leaseTimers = new Map(activeChannels.map((channel) => [channel, null]));
  const backlogBytes = new Map(activeChannels.map((channel) => [channel, 0]));
  // Audio accepted since the last boundary (or stream start), in bytes. Only
  // audio the worker accepted is counted, so a refused append cannot advance
  // the window past audio the worker never received.
  const windowBytes = new Map(activeChannels.map((channel) => [channel, 0]));
  // The boundary call that has not settled yet, if any. A forced cut must not
  // pile a second boundary behind an unresolved one: the worker would emit
  // two finals for the same audio.
  const pendingBoundaries = new Map(activeChannels.map((channel) => [channel, null]));
  const startedChannels = new Set();
  const maxBacklogBytes = Math.max(1, Math.floor((Number(maxBacklogSeconds) || DEFAULT_MAX_BACKLOG_SECONDS) * BYTES_PER_SECOND));
  const maxWindowBytes = Number.isFinite(Number(maxWindowMs)) && Number(maxWindowMs) > 0
    ? Math.max(1, Math.floor((Number(maxWindowMs) / 1000) * BYTES_PER_SECOND))
    : 0;

  function clearLease(channel) {
    const timer = leaseTimers.get(channel);
    if (timer) clearTimeout(timer);
    leaseTimers.set(channel, null);
  }

  function armLease(channel) {
    clearLease(channel);
    const ms = Number(leaseMs);
    if (!Number.isFinite(ms) || ms <= 0 || stopped || !startedChannels.has(channel)) return;
    const timer = setTimeout(() => expireLease(channel), ms);
    if (typeof timer.unref === 'function') timer.unref();
    leaseTimers.set(channel, timer);
  }

  function expireLease(channel) {
    leaseTimers.set(channel, null);
    if (stopped || !ready || !startedChannels.has(channel)) return;
    startedChannels.delete(channel);
    backlogBytes.set(channel, 0);
    clearRecovery(channel);
    clearWindow(channel);
    const error = new Error(`No audio or heartbeat from ${channel} for ${leaseMs} ms; cancelling its local stream.`);
    error.code = 'speech_stream_lease_expired';
    Promise.resolve(worker.streamCancel(channel)).catch(() => {});
    reportFailure(error);
  }

  function touchLease(channel) {
    if (startedChannels.has(channel)) armLease(channel);
  }

  function settleWithin(promise, ms, code, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(message);
        error.code = code;
        reject(error);
      }, ms);
      // Not unref'd: a finish deadline exists to make Stop settle, so it must
      // keep the loop alive for its own duration instead of vanishing early.
      Promise.resolve(promise).then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function reportFailure(error) {
    if (failureNotified || stopped) return;
    failureNotified = true;
    ready = false;
    for (const channel of activeChannels) clearLease(channel);
    startedChannels.clear();
    onError(error);
  }

  function startupCancelledError() {
    const error = new Error('Local speech stream startup was cancelled.');
    error.code = 'speech_stream_start_cancelled';
    return error;
  }

  function clearRecovery(channel) {
    const state = recovery.get(channel);
    if (state) { state.chunks = []; state.bytes = 0; state.offset = 0; state.boundaries = []; }
  }

  function clearWindow(channel) {
    windowBytes.set(channel, 0);
    pendingBoundaries.set(channel, null);
  }

  function requestBoundary(channel) {
    const state = recovery.get(channel);
    // Absolute position of this boundary in the retained chunk stream. The
    // final that matches it will arrive asynchronously; a second boundary
    // must queue behind it rather than overwrite it.
    if (state) state.boundaries.push(state.offset + state.chunks.length);
    // The call itself is issued synchronously so a forward cut lands after the
    // feeds already handed to the worker; only its settlement is tracked.
    const pending = Promise.resolve(worker.streamBoundary(channel))
      .catch(reportFailure)
      .finally(() => {
        if (pendingBoundaries.get(channel) === pending) pendingBoundaries.set(channel, null);
      });
    pendingBoundaries.set(channel, pending);
  }

  function rememberRecovery(channel, pcm) {
    const state = recovery.get(channel);
    if (!state) return;
    state.chunks.push(pcm);
    state.bytes += pcm.length;
    while (state.chunks.length > MAX_RECOVERY_CHUNKS || state.bytes > MAX_RECOVERY_BYTES) {
      const dropped = state.chunks.shift();
      if (!dropped) break;
      state.bytes -= dropped.length;
      state.offset += 1;
    }
  }

  function takeRecoveryAudio() {
    const result = {};
    for (const channel of activeChannels) {
      const state = recovery.get(channel);
      result[channel] = state ? [...state.chunks] : [];
      clearRecovery(channel);
    }
    return result;
  }

  function handleWorkerEvent(event) {
    if (!event || !activeChannels.includes(event.channel)) return;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    if (event.type === 'speech.partial') onPartial({ channel: event.channel, ...data });
    else if (event.type === 'speech.final') {
      backlogBytes.set(event.channel, 0);
      touchLease(event.channel);
      // A final covers only the audio up to the boundary it finalizes. Audio
      // appended after that boundary belongs to the next utterance, so keep
      // it for fallback instead of wiping the whole buffer. Consume exactly
      // one queued boundary per final, in the order the worker emits finals.
      const state = recovery.get(event.channel);
      const boundary = state && state.boundaries.length ? state.boundaries.shift() : null;
      if (state && boundary !== null) {
        const consume = Math.max(0, boundary - state.offset);
        if (consume > 0) {
          const consumed = state.chunks.splice(0, consume);
          for (const chunk of consumed) state.bytes -= chunk.length;
          state.offset += consumed.length;
        }
      } else {
        clearRecovery(event.channel);
      }
      onFinal({ channel: event.channel, ...data });
    }
    else if (event.type === 'speech.error') {
      const error = new Error(String(data.message || 'Local speech streaming failed.'));
      error.code = String(data.code || 'speech_stream_failed');
      reportFailure(error);
    }
  }

  function start() {
    if (ready) return Promise.resolve({ started: true, channels: [...activeChannels] });
    if (startPromise) return startPromise;
    if (stopped) return Promise.reject(new Error('Local speech stream manager has already stopped.'));
    worker.events.on('event', handleWorkerEvent);
    startPromise = (async () => {
      const started = [];
      try {
        for (const channel of activeChannels) {
          if (stopped) throw startupCancelledError();
          await worker.streamStart({ modelId, channel, language, backend, vocabulary });
          started.push(channel);
          startedChannels.add(channel);
          armLease(channel);
          onState({ channel, status: 'streaming', modelId });
          if (stopped) throw startupCancelledError();
        }
        ready = true;
        return { started: true, channels: [...started] };
      } catch (error) {
        for (const channel of activeChannels) clearRecovery(channel);
        for (const channel of activeChannels) clearLease(channel);
        startedChannels.clear();
        const cleanupResults = await Promise.allSettled(started.map((channel) => worker.streamCancel(channel)));
        worker.events.removeListener('event', handleWorkerEvent);
        const cleanupErrors = cleanupResults
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason);
        if (cleanupErrors.length) {
          throw new AggregateError([error, ...cleanupErrors], 'Local speech stream startup and cleanup failed.');
        }
        throw error;
      }
    })();
    return startPromise;
  }

  function append(channel, pcm) {
    if (!ready || stopped || !inFlight.has(channel)) return false;
    const count = inFlight.get(channel);
    if (count >= maxInFlight) {
      const error = new Error(`Local ${channel} transcription could not keep up with incoming audio.`);
      error.code = 'speech_stream_backpressure';
      reportFailure(error);
      return false;
    }
    const backlog = (backlogBytes.get(channel) || 0) + pcm.length;
    if (backlog > maxBacklogBytes) {
      const error = new Error(`Local ${channel} audio backlog exceeded ${Math.round(maxBacklogBytes / BYTES_PER_SECOND)}s; refusing more audio.`);
      error.code = 'speech_stream_backlog_exceeded';
      reportFailure(error);
      return false;
    }
    backlogBytes.set(channel, backlog);
    touchLease(channel);

    inFlight.set(channel, count + 1);
    rememberRecovery(channel, pcm);
    const activity = vads.get(channel).push(pcm);
    worker.streamFeed(channel, pcm).catch(reportFailure).finally(() => {
      inFlight.set(channel, Math.max(0, inFlight.get(channel) - 1));
    });
    // Count only audio the worker accepted. This chunk belongs to the window
    // that is about to end when it crosses the limit.
    const windowed = (windowBytes.get(channel) || 0) + pcm.length;
    windowBytes.set(channel, windowed);
    if (activity.speechStopped) {
      vads.get(channel).reset();
      // A VAD stop already ends the worker window, so it resets the forced
      // window too; the next window starts with the next accepted sample.
      clearWindow(channel);
      requestBoundary(channel);
    } else if (maxWindowBytes > 0 && windowed >= maxWindowBytes && !pendingBoundaries.get(channel)) {
      // Continuous speech never reports a stop. Cut it at the bound instead of
      // letting the worker accumulate one unbounded window until Stop.
      clearWindow(channel);
      requestBoundary(channel);
    }
    return true;
  }

  function stop({ finish = false } = {}) {
    if (stopPromise) return stopPromise;
    if (stopped) return Promise.resolve();
    stopped = true;
    ready = false;
    for (const channel of activeChannels) {
      clearRecovery(channel);
      clearLease(channel);
      clearWindow(channel);
      backlogBytes.set(channel, 0);
    }
    startedChannels.clear();
    stopPromise = (async () => {
      if (startPromise) {
        try {
          await startPromise;
        } catch (error) {
          if (!error || error.code !== 'speech_stream_start_cancelled') onError(error);
        }
      }
      const stopMethod = finish ? 'streamFinish' : 'streamCancel';
      const deadline = Math.max(1, Number(finishDeadlineMs) || DEFAULT_FINISH_DEADLINE_MS);
      const results = await Promise.allSettled(activeChannels.map(async (channel) => {
        if (typeof worker[stopMethod] !== 'function') return undefined;
        const pending = Promise.resolve(worker[stopMethod](channel));
        if (stopMethod !== 'streamFinish') {
          // Cancel is the last line of defence for Stop. A worker that never
          // answers it must not keep the user waiting either.
          return settleWithin(
            pending,
            Math.min(deadline, 1000),
            'speech_stream_cancel_timeout',
            `Local ${channel} stream did not cancel within ${Math.min(deadline, 1000)} ms.`,
          );
        }
        try {
          // Stop must settle: a worker that never acknowledges stream-finish is
          // cancelled at the deadline instead of holding the user's Stop.
          return await settleWithin(
            pending,
            deadline,
            'speech_stream_finish_timeout',
            `Local ${channel} stream did not finish within ${deadline} ms; cancelling it.`,
          );
        } catch (error) {
          if (error && error.code === 'speech_stream_finish_timeout') {
            if (typeof worker.streamCancel === 'function') {
              try {
                await settleWithin(
                  Promise.resolve(worker.streamCancel(channel)),
                  Math.min(deadline, 1000),
                  'speech_stream_cancel_timeout',
                  `Local ${channel} stream did not cancel within ${Math.min(deadline, 1000)} ms.`,
                );
              } catch {}
            }
          }
          throw error;
        }
      }));
      worker.events.removeListener('event', handleWorkerEvent);
      onState({ status: 'stopped' });
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length) {
        const error = new AggregateError(errors, 'One or more local speech streams could not be stopped.');
        onError(error);
        throw error;
      }
    })();
    return stopPromise;
  }

  function heartbeat(channel) {
    if (!activeChannels.includes(channel) || !startedChannels.has(channel)) return false;
    armLease(channel);
    return true;
  }

  return {
    start,
    append,
    heartbeat,
    stop,
    takeRecoveryAudio,
    get ready() { return ready && !stopped; },
    get channels() { return [...activeChannels]; },
    get backlogBytes() { return Object.fromEntries(activeChannels.map((channel) => [channel, backlogBytes.get(channel) || 0])); },
    // Accepted audio in the current window, in milliseconds. Diagnostics only;
    // the boundary itself is driven by the byte counter above.
    get windowMs() {
      return Object.fromEntries(activeChannels.map((channel) => [
        channel,
        Math.round(((windowBytes.get(channel) || 0) / BYTES_PER_SECOND) * 1000),
      ]));
    },
  };
}

module.exports = { createLocalSpeechStreamManager };
