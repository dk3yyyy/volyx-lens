'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const {
  getModel, isInstalled, modelPaths, verifyModel,
  speechDetectorPaths, isSpeechDetectorInstalled, verifySpeechDetector,
  speechDiarizerInfo, speechDiarizerPaths, isSpeechDiarizerInstalled, verifySpeechDiarizer,
} = require('./speech-model-registry');

const WORKER_NAME = 'volyx-speech-worker';
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
// Parakeet's boosting budget is small and finite: a long tail of terms dilutes
// the rescoring pass instead of sharpening it, and long "terms" are phrases
// the model cannot match as a unit.
const MAX_VOCABULARY_TERMS = 40;
const MAX_VOCABULARY_TERM_CHARACTERS = 40;

// The recorder retains at most 10 minutes of 24 kHz mono 16-bit PCM
// (src/diarization-session.js) and the native worker enforces the same bound.
const DIARIZATION_SAMPLE_RATE = 24_000;
const MAX_DIARIZATION_AUDIO_MS = 10 * 60 * 1000;
const MAX_DIARIZATION_PCM_BYTES = Math.floor((MAX_DIARIZATION_AUDIO_MS / 1000) * DIARIZATION_SAMPLE_RATE * 2);
const MAX_DIARIZATION_WAV_BYTES = MAX_DIARIZATION_PCM_BYTES + 44;
// One conversational chunk, not a whole meeting: VAD detection and stream
// feeds are called with 80 ms frames. A megabyte is already far beyond that
// and keeps the base64 request small.
const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024;

// Diarization is an inference over the whole recording, not a model load.
// Budget four times the audio duration plus 30 s of slack, never less than the
// model-load budget and never more than 15 minutes, so the watchdog scales with
// the accepted input instead of killing a legitimate multi-minute analysis.
const DIARIZATION_TIMEOUT_MULTIPLIER = 4;
const DIARIZATION_TIMEOUT_SLACK_MS = 30_000;
const MAX_DIARIZATION_TIMEOUT_MS = 15 * 60 * 1000;

function wavAudioMs(wav) {
  if (Buffer.isBuffer(wav) && wav.length >= 44
      && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE') {
    const sampleRate = wav.readUInt32LE(24);
    const channels = wav.readUInt16LE(22) || 1;
    const declared = wav.readUInt32LE(40);
    const dataBytes = Math.min(declared > 0 ? declared : wav.length - 44, wav.length - 44);
    if (sampleRate > 0 && dataBytes > 0) {
      return Math.round((dataBytes / 2 / channels / sampleRate) * 1000);
    }
  }
  // Raw PCM fallback: the caller's WAV builder uses the recorder's 24 kHz.
  return Math.round((Math.max(0, wav.length - 44) / 2 / DIARIZATION_SAMPLE_RATE) * 1000);
}

function diarizationTimeoutMs(wav, floorMs, slackMs = DIARIZATION_TIMEOUT_SLACK_MS) {
  const scaled = (wavAudioMs(wav) * DIARIZATION_TIMEOUT_MULTIPLIER) + slackMs;
  return Math.min(MAX_DIARIZATION_TIMEOUT_MS, Math.max(floorMs, scaled));
}

function assertAudioPayloadSize(bytes, maximum, label) {
  if (!Number.isFinite(bytes) || bytes > maximum) {
    throw workerError(
      'speech_audio_payload_too_large',
      `${label} payload exceeds the maximum accepted size of ${maximum} bytes.`,
    );
  }
}

function speechWorkerCandidates({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
  projectDir = path.resolve(__dirname, '..'),
} = {}) {
  const candidates = [];
  if (!['darwin', 'win32', 'linux'].includes(platform)) return candidates;
  const binaryName = platform === 'win32' ? `${WORKER_NAME}.exe` : WORKER_NAME;
  const fromEnv = String(env.VOLYX_LENS_SPEECH_WORKER_BIN || '').trim();
  if (fromEnv && path.isAbsolute(fromEnv)) candidates.push(fromEnv);
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'native', binaryName));
  candidates.push(path.join(projectDir, 'native-bin', binaryName));
  return candidates;
}

function resolveSpeechWorkerBinary(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  const candidates = speechWorkerCandidates(options);
  const found = candidates.find((candidate) => {
    try {
      const stat = fsImpl.statSync(candidate);
      if (!stat.isFile()) return false;
      if (platform !== 'win32') {
        if ((stat.mode & 0o002) !== 0) return false;
        // Accept the running user's binary or a root-owned install (pkg/MDM
        // installs land under /Applications owned by root); anything else is
        // refused. World-writable is still rejected above.
        if (typeof process.getuid === 'function' && stat.uid !== 0 && stat.uid !== process.getuid()) return false;
      }
      fsImpl.accessSync(candidate, platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK);
      fsImpl.realpathSync(candidate);
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      if (error && error.code === 'EACCES') return false;
      throw error;
    }
  });
  if (found) return { available: true, path: found, reason: '' };
  const arch = options.arch || process.arch;
  const reason = !['darwin', 'win32', 'linux'].includes(platform)
    ? 'Local GGUF inference is not supported on this platform.'
    : `The local speech worker is not installed for ${platform}/${arch}. Rebuild the native helper or install a supported package.`;
  return { available: false, path: '', reason };
}

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeBackend(value) {
  return ['auto', 'cpu', 'gpu'].includes(value) ? value : 'auto';
}

// Diarization is cancellable at every await point: a New Session, history-off,
// or quit must not leave a recording of the meeting being analyzed or persisted
// after the user ended it.
function throwIfDiarizationCancelled(isCancelled) {
  if (typeof isCancelled === 'function' && isCancelled()) {
    throw workerError('diarization_cancelled', 'Speaker diarization was canceled.');
  }
}

const DIARIZER_PROGRESS_TYPES = new Set([
  'diarize-progress',
  'diarization-progress',
  'speech.diarize.progress',
  'speech.diarizer.progress',
]);

function isDiarizerProgress(event) {
  if (!event || typeof event !== 'object') return false;
  const type = String(event.type || '').toLowerCase();
  return DIARIZER_PROGRESS_TYPES.has(type) || (type.includes('diariz') && type.includes('progress'));
}

// Vocabulary is advisory: a malformed entry is dropped rather than failing a
// transcription the user is waiting for. Mirrors the caps enforced by the
// native worker so neither side can widen the other's budget.
function sanitizeVocabulary(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const terms = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const term = entry.trim();
    if (!term || term.length > MAX_VOCABULARY_TERM_CHARACTERS) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_VOCABULARY_TERMS) break;
  }
  return terms;
}

function speechWorkerEnvironment(env = process.env) {
  const allowed = [
    'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
    'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS', 'APPDATA', 'LOCALAPPDATA',
    'VK_ICD_FILENAMES', 'VK_LAYER_PATH', 'GGML_VULKAN_DEVICE',
  ];
  const values = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const result = {};
  for (const key of allowed) {
    const value = values.get(key.toLowerCase());
    if (value) result[key] = value;
  }
  if (!result.PATH) result.PATH = '/usr/bin:/bin';
  if (!result.HOME) result.HOME = os.homedir();
  if (!result.TMPDIR) result.TMPDIR = os.tmpdir();
  if (!result.LANG) result.LANG = 'en_US.UTF-8';
  return result;
}

function createSpeechWorker({
  binaryPath = '',
  binaryResolver = resolveSpeechWorkerBinary,
  spawnImpl = spawn,
  env = process.env,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  modelOperationTimeoutMs = 120_000,
  diarizationTimeoutSlackMs = DIARIZATION_TIMEOUT_SLACK_MS,
  idleUnloadMs = 5 * 60 * 1000,
  stopTimeoutMs = 3000,
  cwd = os.tmpdir(),
} = {}) {
  let child = null;
  let lineReader = null;
  let sequence = 0;
  let expectedExit = false;
  let workerGeneration = 0;
  // Process starts bump workerGeneration; real stops bump stopEpoch. A load must
  // only be cancelled by a stop, not by another channel's cold start.
  let stopEpoch = 0;
  let pendingLoad = null;
  let stopPromise = null;
  let loadedModelId = '';
  let warmedModelId = '';
  let vadLoaded = false;
  let loadedBackendPreference = '';
  let activeBackend = '';
  let activeBackendFallback = false;
  let diarizerLoaded = false;
  let diarizerBackendPreference = '';
  let diarizerStatus = null;
  let activeDiarizerBackend = '';
  let diarizerBackendFallback = false;
  const activeStreams = new Set();
  let idleTimer = null;
  let stderrTail = '';
  const pending = new Map();
  const events = new EventEmitter();

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function failWorker(error, generation = workerGeneration) {
    if (generation !== workerGeneration) return;
    loadedModelId = '';
    warmedModelId = '';
    vadLoaded = false;
    clearActiveBackend();
    clearDiarizerState();
    activeStreams.clear();
    rejectPending(error);
  }

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function backendPreferenceSatisfied(preference) {
    if (preference === 'cpu') return activeBackend === 'cpu';
    if (preference === 'auto') {
      return loadedBackendPreference === 'auto' || Boolean((activeBackend && activeBackend !== 'cpu') || activeBackendFallback);
    }
    return Boolean((activeBackend && activeBackend !== 'cpu') || activeBackendFallback);
  }

  function clearActiveBackend() {
    loadedBackendPreference = '';
    activeBackend = '';
    activeBackendFallback = false;
  }

  function clearDiarizerState() {
    diarizerLoaded = false;
    diarizerBackendPreference = '';
    diarizerStatus = null;
    activeDiarizerBackend = '';
    diarizerBackendFallback = false;
  }

  function recordBackendResult(result) {
    if (result && result.backend) activeBackend = String(result.backend).toLowerCase();
    if (result && result.backendFallback === true) activeBackendFallback = true;
  }

  async function clearModelAfterFailure() {
    try {
      if (child && loadedModelId) await request('unload', {}, 10_000);
    } catch {}
    loadedModelId = '';
    warmedModelId = '';
    clearActiveBackend();
  }

  function scheduleIdleUnload() {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // The diarizer shares the worker process, so an idle window must release
      // both models or the 139 MB Sortformer weights stay resident forever.
      Promise.allSettled([unloadModel(), unloadDiarizer()]).then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) events.emit('runtime-error', failed.reason);
      });
    }, idleUnloadMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  function ensureStarted() {
    if (stopPromise) throw workerError('speech_worker_stopping', 'The local speech worker is still stopping.');
    if (child && child.exitCode === null && child.signalCode === null) return child;
    const resolved = binaryPath ? { available: true, path: binaryPath } : binaryResolver();
    if (!resolved.available) throw workerError('speech_runtime_unavailable', resolved.reason);

    const generation = ++workerGeneration;
    expectedExit = false;
    stderrTail = '';
    const workerEnv = speechWorkerEnvironment(env);
    const activeChild = spawnImpl(resolved.path, [], {
      cwd,
      env: workerEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = activeChild;
    lineReader = readline.createInterface({ input: activeChild.stdout });
    lineReader.on('line', (line) => {
      if (generation !== workerGeneration || child !== activeChild) return;
      let message;
      try { message = JSON.parse(line); } catch (error) {
        failWorker(workerError('speech_worker_protocol_error', `Speech worker returned invalid JSON: ${error.message}`), generation);
        if (!activeChild.killed) activeChild.kill();
        return;
      }
      if (message && message.event === true) {
        events.emit('event', message);
        return;
      }
      const entry = message && pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.ok === true) entry.resolve(message.result);
      else entry.reject(workerError(
        message.error && message.error.code || 'speech_worker_error',
        message.error && message.error.message || 'Speech worker request failed.',
      ));
    });
    activeChild.stderr.on('data', (chunk) => {
      if (generation !== workerGeneration || child !== activeChild) return;
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4000);
    });
    activeChild.stdin.on('error', (error) => {
      if (generation !== workerGeneration || child !== activeChild) return;
      failWorker(workerError('speech_worker_write_failed', error.message), generation);
      if (!activeChild.killed) activeChild.kill();
    });
    activeChild.on('error', (error) => {
      if (generation !== workerGeneration || child !== activeChild) return;
      // A spawn failure emits no 'exit'; leaving the dead child in place made
      // every later request reuse it until someone called stop().
      if (lineReader) { lineReader.close(); lineReader = null; }
      child = null;
      failWorker(workerError('speech_worker_spawn_failed', error.message), generation);
    });
    activeChild.on('exit', (code, signal) => {
      if (generation !== workerGeneration || child !== activeChild) return;
      if (lineReader) lineReader.close();
      child = null;
      lineReader = null;
      loadedModelId = '';
      warmedModelId = '';
      vadLoaded = false;
      clearActiveBackend();
      clearDiarizerState();
      activeStreams.clear();
      if (!expectedExit) {
        const detail = stderrTail.trim();
        failWorker(workerError(
          'speech_worker_exited',
          `Speech worker exited${code === null ? ` with signal ${signal || 'unknown'}` : ` with code ${code}`}.${detail ? ` ${detail}` : ''}`,
        ), generation);
      }
    });
    return activeChild;
  }

  function request(command, values = {}, timeoutMs = requestTimeoutMs, {
    timeoutCode = 'speech_worker_timeout',
    killOnTimeout = true,
  } = {}) {
    let activeChild;
    try { activeChild = ensureStarted(); } catch (error) { return Promise.reject(error); }
    const id = ++sequence;
    const generation = workerGeneration;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const processDied = activeChild.exitCode !== null || activeChild.signalCode !== null;
        // A wall-clock timeout is a crash only when the process actually died.
        // Otherwise report a command-specific timeout and reclaim the worker
        // without surfacing a bogus "worker exited" or a crash record.
        reject(workerError(
          processDied ? 'speech_worker_exited' : timeoutCode,
          processDied
            ? `Speech worker exited before completing: ${command}`
            : `Speech worker command timed out: ${command}`,
        ));
        if (generation === workerGeneration && child === activeChild && !processDied) {
          if (killOnTimeout && !activeChild.killed) activeChild.kill('SIGKILL');
          stop().catch(() => {});
        }
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      activeChild.stdin.write(`${JSON.stringify({ id, command, ...values })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(workerError('speech_worker_write_failed', error.message));
      });
    });
  }

  function loadModel(modelId, { backend = 'auto' } = {}) {
    const model = getModel(modelId);
    if (!model || model.runtime !== 'transcribe-cpp') {
      return Promise.reject(workerError('speech_model_unsupported', `Unsupported local GGUF model: ${String(modelId || '')}`));
    }
    if (!isInstalled(model.id)) {
      return Promise.reject(workerError('speech_model_not_installed', `Download ${model.name} before using it offline.`));
    }
    const preferredBackend = normalizeBackend(backend);
    const key = `${model.id}|${preferredBackend}`;
    // You and Them flush together on a cold start. Both callers share one load
    // instead of racing to start the worker and cancelling each other.
    if (pendingLoad && pendingLoad.key === key) return pendingLoad.promise;
    if (pendingLoad && pendingLoad.key !== key) {
      return pendingLoad.promise.then(() => loadModel(modelId, { backend }));
    }
    const promise = performLoad(model, preferredBackend);
    pendingLoad = { key, promise };
    return promise.finally(() => {
      if (pendingLoad && pendingLoad.promise === promise) pendingLoad = null;
    });
  }

  async function performLoad(model, preferredBackend) {
    const backendSatisfied = backendPreferenceSatisfied(preferredBackend);
    if (loadedModelId === model.id && backendSatisfied) {
      if (preferredBackend === 'cpu') {
        loadedBackendPreference = 'cpu';
        activeBackendFallback = false;
      }
      return { modelId: model.id, loaded: true, backend: activeBackend, backendFallback: activeBackendFallback };
    }
    const epochAtStart = stopEpoch;
    if (!await verifyModel(model.id)) {
      throw workerError('speech_model_integrity_mismatch', `The downloaded ${model.name} failed its SHA-256 integrity check. Download it again before use.`);
    }
    if (epochAtStart !== stopEpoch) {
      throw workerError('speech_worker_stopped', 'Speech worker was stopped before the model could load.');
    }
    if (loadedModelId) await unloadModel();
    clearIdleTimer();
    const result = await request('load', { modelId: model.id, path: modelPaths(model.id).model, backend: preferredBackend }, modelOperationTimeoutMs);
    if (result.modelId !== model.id || !result.capabilities) {
      throw workerError('speech_worker_protocol_error', 'Speech worker loaded a different model or omitted capabilities.');
    }
    loadedModelId = model.id;
    loadedBackendPreference = preferredBackend;
    activeBackend = String(result.backend || '').toLowerCase();
    activeBackendFallback = result.backendFallback === true;
    warmedModelId = '';
    return result;
  }

  async function warmModel(modelId, options = {}) {
    await loadModel(modelId, options);
    if (warmedModelId === modelId) {
      scheduleIdleUnload();
      return { warmed: true, cached: true };
    }
    let result;
    try {
      result = await request('warm', {}, modelOperationTimeoutMs);
    } catch (error) {
      await clearModelAfterFailure();
      throw error;
    }
    if (result.warmed !== true) {
      await clearModelAfterFailure();
      throw workerError('speech_model_warmup_failed', 'Speech model warm-up did not complete.');
    }
    recordBackendResult(result);
    warmedModelId = modelId;
    scheduleIdleUnload();
    return result;
  }

  async function hardwareInfo() {
    return request('hardware-info', {}, 10_000);
  }

  async function loadVad() {
    if (vadLoaded) return { loaded: true, cached: true };
    if (!isSpeechDetectorInstalled()) throw workerError('speech_vad_not_installed', 'Download the Silero speech detector before using neural VAD.');
    if (!await verifySpeechDetector()) throw workerError('speech_vad_integrity_mismatch', 'The Silero speech detector failed its SHA-256 integrity check.');
    const result = await request('vad-load', { path: speechDetectorPaths().model }, modelOperationTimeoutMs);
    if (result.loaded !== true) throw workerError('speech_vad_load_failed', 'Speech detector load did not complete.');
    vadLoaded = true;
    return result;
  }

  async function detectSpeech(pcm, { threshold = 0.4, minSpeechMs = 160 } = {}) {
    if (!vadLoaded) throw workerError('speech_vad_not_loaded', 'Load the speech detector before detecting speech.');
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) {
      throw new TypeError('Neural VAD requires non-empty 16-bit PCM audio.');
    }
    assertAudioPayloadSize(pcm.length, MAX_AUDIO_CHUNK_BYTES, 'Neural VAD');
    return request('vad-detect', {
      pcm16Base64: pcm.toString('base64'),
      threshold: Math.max(0.01, Math.min(0.99, Number(threshold) || 0.4)),
      minSpeechMs: Math.max(0, Math.min(2000, Number(minSpeechMs) || 160)),
    }, 30_000);
  }

  async function unloadVad() {
    if (!vadLoaded) return { unloaded: true, loaded: false };
    const result = await request('vad-unload', {}, modelOperationTimeoutMs);
    vadLoaded = false;
    return result;
  }

  async function loadDiarizer({ backend = 'auto', isCancelled } = {}) {
    throwIfDiarizationCancelled(isCancelled);
    const info = speechDiarizerInfo();
    if (!isSpeechDiarizerInstalled()) {
      throw workerError('speech_diarizer_not_installed', 'Download the Sortformer diarizer before using speaker attribution.');
    }
    const preference = normalizeBackend(backend);
    const satisfied = diarizerLoaded && (
      preference === diarizerBackendPreference
      || (preference === 'gpu' && activeDiarizerBackend && activeDiarizerBackend !== 'cpu')
    );
    if (satisfied) return { ...diarizerStatus, loaded: true, cached: true };
    const epochAtStart = stopEpoch;
    if (!await verifySpeechDiarizer()) {
      throw workerError('speech_diarizer_integrity_mismatch', 'The Sortformer diarizer failed its SHA-256 integrity check.');
    }
    // Artifact verification can take seconds; a stop or cancel during it must
    // not spawn a worker or load weights the user already ended.
    if (epochAtStart !== stopEpoch) {
      throw workerError('speech_worker_stopped', 'Speech worker was stopped before the diarizer could load.');
    }
    throwIfDiarizationCancelled(isCancelled);
    clearIdleTimer();
    clearDiarizerState();
    try {
      const result = await request('diarize-load', {
        modelId: info.id,
        path: speechDiarizerPaths().model,
        backend: preference,
      }, modelOperationTimeoutMs);
      throwIfDiarizationCancelled(isCancelled);
      if (result.modelId !== info.id || result.maxSpeakers !== info.maxSpeakers || result.sampleRate !== info.sampleRate) {
        throw workerError('speech_worker_protocol_error', 'Speech worker loaded an unexpected diarization model.');
      }
      diarizerLoaded = true;
      diarizerBackendPreference = preference;
      diarizerStatus = result;
      activeDiarizerBackend = String(result.backend || '').toLowerCase();
      diarizerBackendFallback = result.backendFallback === true;
      return result;
    } catch (error) {
      clearDiarizerState();
      if (child) {
        try { await request('diarize-unload', {}, 10_000); } catch {}
      }
      throw error;
    }
  }

  async function runDiarizer({ wav, preset = 'very_high_latency', backend = 'auto', isCancelled, onProgress } = {}) {
    if (!Buffer.isBuffer(wav)) throw new TypeError('Speaker diarization requires a WAV Buffer.');
    if (!['low_latency', 'high_latency', 'very_high_latency'].includes(preset)) {
      throw new TypeError('Unsupported diarization preset.');
    }
    // Refuse an absurd recording before base64-encoding it: the encoder would
    // allocate ~1.34x the buffer as an immutable string.
    assertAudioPayloadSize(wav.length, MAX_DIARIZATION_WAV_BYTES, 'Speaker diarization');
    throwIfDiarizationCancelled(isCancelled);
    // Native progress events arrive on the shared worker event stream. Scope the
    // listener to this run so a renderer/status callback cannot leak into the
    // next analysis or keep firing after cancellation.
    const progressListener = typeof onProgress === 'function'
      ? (event) => {
        if (!isDiarizerProgress(event)) return;
        try { onProgress(event); } catch {}
      }
      : null;
    if (progressListener) events.on('event', progressListener);
    try {
      await loadDiarizer({ backend, isCancelled });
      throwIfDiarizationCancelled(isCancelled);
      // The 120 s model-load budget is not an inference budget: a 10-minute
      // recording can legitimately take minutes. Scale the watchdog to the
      // audio and keep killing only as a last resort for an unresponsive
      // process (a timeout alone is not a worker crash).
      const timeoutMs = diarizationTimeoutMs(wav, modelOperationTimeoutMs, diarizationTimeoutSlackMs);
      const result = await request('diarize-run', {
        wavBase64: wav.toString('base64'),
        preset,
      }, timeoutMs, { timeoutCode: 'speech_diarizer_timeout', killOnTimeout: false });
      if (!Array.isArray(result.segments)) {
        throw workerError('speech_worker_protocol_error', 'Speech worker omitted diarization segments.');
      }
      return result;
    } finally {
      if (progressListener) events.off('event', progressListener);
      scheduleIdleUnload();
    }
  }

  async function unloadDiarizer() {
    if (!diarizerLoaded) {
      clearDiarizerState();
      return { unloaded: true, loaded: false };
    }
    const result = await request('diarize-unload', {}, modelOperationTimeoutMs);
    clearDiarizerState();
    return result;
  }

  async function transcribe({ wav, modelId, language = '', backend = 'auto', vocabulary = [] } = {}) {
    if (!Buffer.isBuffer(wav)) throw new TypeError('Local speech transcription requires a WAV Buffer.');
    const model = getModel(modelId);
    if (!model || model.runtime !== 'transcribe-cpp') {
      throw workerError('speech_model_unsupported', `Unsupported local GGUF model: ${String(modelId || '')}`);
    }
    const terms = sanitizeVocabulary(vocabulary);
    try {
      await warmModel(model.id, { backend });
      const result = await request('transcribe', {
        wavBase64: wav.toString('base64'),
        language: String(language || ''),
        ...(terms.length ? { vocabulary: terms } : {}),
      });
      recordBackendResult(result);
      return { ...result, modelId: model.id, provider: 'local-gguf' };
    } catch (error) {
      if (loadedModelId) await clearModelAfterFailure();
      throw error;
    } finally {
      scheduleIdleUnload();
    }
  }

  async function streamStart({ modelId, channel, language = '', backend = 'auto', vocabulary = [] } = {}) {
    const model = getModel(modelId);
    if (!model || model.runtime !== 'transcribe-cpp' || model.streaming !== true) {
      throw workerError('speech_model_streaming_unsupported', `The selected local model does not support streaming: ${String(modelId || '')}`);
    }
    if (!['you', 'them'].includes(channel)) throw new TypeError('Local speech streaming requires a valid audio channel.');
    if (activeStreams.has(channel)) throw workerError('speech_stream_already_started', `A local speech stream is already active for ${channel}.`);
    if (!isInstalled(model.id)) {
      throw workerError('speech_model_not_installed', `Download ${model.name} before using it offline.`);
    }
    const terms = sanitizeVocabulary(vocabulary);
    if (!await verifyModel(model.id)) {
      throw workerError('speech_model_integrity_mismatch', `The downloaded ${model.name} failed its SHA-256 integrity check. Download it again before use.`);
    }
    clearIdleTimer();
    const preferredBackend = normalizeBackend(backend);
    if (loadedModelId && !backendPreferenceSatisfied(preferredBackend)) {
      if (activeStreams.size > 0) {
        throw workerError('speech_backend_change_active', 'Stop active local speech streams before changing the compute backend.');
      }
      await unloadModel();
    }
    const reuseCpuFallback = preferredBackend === 'gpu' && activeBackendFallback && activeBackend === 'cpu';
    const requestedBackend = reuseCpuFallback ? 'cpu' : preferredBackend;
    try {
      const result = await request('stream-start', {
        modelId: model.id,
        path: modelPaths(model.id).model,
        channel,
        language: String(language || ''),
        backend: requestedBackend,
        ...(terms.length ? { vocabulary: terms } : {}),
      }, modelOperationTimeoutMs);
      if (result.modelId !== model.id || !result.capabilities || result.capabilities.streaming !== true) {
        throw workerError('speech_worker_protocol_error', 'Speech worker started an unexpected model or omitted streaming capabilities.');
      }
      loadedModelId = model.id;
      loadedBackendPreference = preferredBackend;
      activeBackend = String(result.backend || '').toLowerCase();
      activeBackendFallback = result.backendFallback === true || reuseCpuFallback;
      warmedModelId = model.id;
      activeStreams.add(channel);
      return result;
    } catch (error) {
      if (activeStreams.size === 0) {
        loadedModelId = '';
        warmedModelId = '';
        clearActiveBackend();
      }
      throw error;
    }
  }

  async function streamFeed(channel, pcm) {
    if (!activeStreams.has(channel)) throw workerError('speech_stream_not_started', `No local speech stream is active for ${channel}.`);
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) {
      throw new TypeError('Local speech streaming requires non-empty 16-bit PCM audio.');
    }
    assertAudioPayloadSize(pcm.length, MAX_AUDIO_CHUNK_BYTES, 'Local speech streaming');
    return request('stream-feed', { channel, pcm16Base64: pcm.toString('base64') }, 30_000);
  }

  async function streamFinish(channel) {
    return endStream(channel, 'stream-finish');
  }

  async function streamBoundary(channel) {
    if (!activeStreams.has(channel)) throw workerError('speech_stream_not_started', `No local speech stream is active for ${channel}.`);
    return request('stream-boundary', { channel }, 30_000);
  }

  async function streamCancel(channel) {
    return endStream(channel, 'stream-cancel');
  }

  async function endStream(channel, command) {
    if (!activeStreams.has(channel)) return { finished: false, active: false };
    try {
      return await request(command, { channel }, 120_000);
    } finally {
      activeStreams.delete(channel);
      if (activeStreams.size === 0) {
        loadedModelId = '';
        warmedModelId = '';
        clearActiveBackend();
      }
    }
  }

  async function unloadModel(modelId = '') {
    clearIdleTimer();
    if (modelId && loadedModelId && modelId !== loadedModelId) {
      throw workerError('speech_model_not_loaded', `Cannot unload ${modelId}; ${loadedModelId} is currently loaded.`);
    }
    if (!child || (!loadedModelId && activeStreams.size === 0)) {
      loadedModelId = '';
      warmedModelId = '';
      clearActiveBackend();
      activeStreams.clear();
      return { unloaded: true, loaded: false };
    }
    const result = await request('unload');
    activeStreams.clear();
    loadedModelId = '';
    warmedModelId = '';
    clearActiveBackend();
    return result;
  }

  async function stop() {
    clearIdleTimer();
    if (stopPromise) return stopPromise;
    // Invalidate in-flight work even when no child exists yet: a load can be
    // awaiting artifact verification and would otherwise spawn a worker after
    // the user already stopped. Only a stop bumps stopEpoch; starting a worker
    // must not cancel a sibling channel's load.
    stopEpoch += 1;
    const generation = ++workerGeneration;
    vadLoaded = false;
    clearDiarizerState();
    activeStreams.clear();
    if (!child) return;
    expectedExit = true;
    const activeChild = child;
    if (lineReader) lineReader.close();
    child = null;
    lineReader = null;
    loadedModelId = '';
    warmedModelId = '';
    clearActiveBackend();
    rejectPending(workerError('speech_worker_stopped', 'Speech worker was stopped.'));
    stopPromise = (async () => {
      try {
        await new Promise((resolve) => {
          const timeout = Number.isFinite(stopTimeoutMs) && stopTimeoutMs > 0 ? stopTimeoutMs : 3000;
          const timer = setTimeout(() => {
            if (!activeChild.killed) activeChild.kill('SIGKILL');
            resolve();
          }, timeout);
          activeChild.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          try { activeChild.stdin.end(); } catch {}
        });
      } finally {
        if (generation === workerGeneration) expectedExit = false;
        stopPromise = null;
      }
    })();
    return stopPromise;
  }

  return {
    events,
    loadModel,
    warmModel,
    transcribe,
    streamStart,
    streamFeed,
    streamBoundary,
    streamFinish,
    streamCancel,
    unloadModel,
    hardwareInfo,
    loadVad,
    detectSpeech,
    unloadVad,
    loadDiarizer,
    runDiarizer,
    diarize: runDiarizer,
    unloadDiarizer,
    stop,
    get loadedModelId() { return loadedModelId; },
    get warmedModelId() { return warmedModelId; },
    get pid() { return child && Number.isInteger(child.pid) ? child.pid : null; },
    get vadLoaded() { return vadLoaded; },
    get diarizerLoaded() { return diarizerLoaded; },
    get activeDiarizerBackend() { return activeDiarizerBackend; },
    get diarizerBackendFallback() { return diarizerBackendFallback; },
    get activeBackend() { return activeBackend; },
    get activeBackendFallback() { return activeBackendFallback; },
  };
}

const defaultSpeechWorker = createSpeechWorker();

module.exports = {
  WORKER_NAME,
  speechWorkerCandidates,
  resolveSpeechWorkerBinary,
  createSpeechWorker,
  speechWorkerEnvironment,
  sanitizeVocabulary,
  wavAudioMs,
  diarizationTimeoutMs,
  defaultSpeechWorker,
};
