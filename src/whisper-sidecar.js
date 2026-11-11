'use strict';

// Whisper.cpp sidecar module for Volyx Lens
//
// Provides:
// - Automatic model download with SHA-256 verification and resume support
// - In-memory transcription (no audio files on disk)
// - Shared inference queue for You + Them channels
// - Dynamic model load/unload
// - Support for ~30 models (tiny → large, quantized, multilingual, TinyDiarize, etc.)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
// Global fetch (Node 20+, and Electron's main process) is the API this module
// uses. It used to require node-fetch, which was never a declared dependency: it
// only resolved because an old SDK happened to pull it in, and the openai 4 to 7
// bump removed it.
const { normalizeWhisperLanguage } = require('./whisper-language');
const { fileFor, unavailableReason, downloadUrl } = require('./whisper-models');
const { RELEASE_VERSION } = require('./whisper-runtime-manifest');

// Model specifications (~30 models)
// The `.int8` ids map to quantized multilingual files (q8_0, and q5_0 for
// large-v3), not English-only ones: only the `.en` ids are English-only.
const MODEL_SPECS = {
  'tiny': { sizeMB: 39, params: '39M', desc: 'Multilingual, very fast, lowest quality' },
  'tiny.en': { sizeMB: 39, params: '39M', desc: 'English-only, very fast, lowest quality' },
  'tiny.int8': { sizeMB: 39, params: '39M', desc: 'Multilingual int8 quantized, very fast' },
  'base': { sizeMB: 142, params: '139M', desc: 'Multilingual, fast, good quality' },
  'base.en': { sizeMB: 142, params: '139M', desc: 'English-only, fast, good quality' },
  'base.int8': { sizeMB: 142, params: '139M', desc: 'Multilingual int8 quantized, fast' },
  'small': { sizeMB: 466, params: '466M', desc: 'Multilingual, balanced speed/quality' },
  'small.en': { sizeMB: 466, params: '466M', desc: 'English-only, balanced speed/quality' },
  'small.int8': { sizeMB: 466, params: '466M', desc: 'Multilingual int8 quantized, balanced' },
  'medium': { sizeMB: 1550, params: '1550M', desc: 'Multilingual, better quality' },
  'medium.en': { sizeMB: 1550, params: '1550M', desc: 'English-only, better quality' },
  'medium.int8': { sizeMB: 1550, params: '1550M', desc: 'Multilingual int8 quantized, better' },
  'large-v3': { sizeMB: 3036, params: '3036M', desc: 'Multilingual, best quality (default)' },
  'large-v3.en': { sizeMB: 3036, params: '3036M', desc: 'English-only, best quality' },
  'large-v3.int8': { sizeMB: 3036, params: '3036M', desc: 'Multilingual q5_0 quantized, best' },
  'large': { sizeMB: 3036, params: '3036M', desc: 'Multilingual, largest (slowest)' },
  'large.int8': { sizeMB: 3036, params: '3036M', desc: 'Multilingual int8 quantized' },
  'distil-large-v3': { sizeMB: 1550, params: '1550M', desc: 'Distilled, faster than large-v3' },
};

// Cache directory for downloaded models
const MODELS_DIR = path.join(os.homedir(), '.volyx-lens', 'whisper-models');

// Ensure the cache directory exists. The model files are 40 MB to 3 GB of the user's
// own downloads, so the directory is private to them (VR-23).
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on filesystems without modes */ }
}

// Get the cache path for a model
function modelCachePath(modelId) {
  return path.join(MODELS_DIR, `${modelId}.bin`);
}

// Get the index path (with SHA-256 verification) for a model
function modelIndexPath(modelId) {
  return path.join(MODELS_DIR, `${modelId}.idx`);
}

// Compute SHA-256 hash of a file without loading it into memory: the largest model is
// over 3 GB (VR-23).
function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function abortError(message = 'Model download aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

// Download a model from Hugging Face with progress and verification.
//
// The bytes are hashed as they arrive, streamed to a private temp file, capped at the
// size the manifest expects, and only moved into place when the digest matches the
// published one. A mirror or a TLS-terminating proxy cannot substitute a different
// model, and peak memory stays at one chunk instead of the whole file (VR-23).
// `signal` makes the whole operation abortable: the fetch is cancelled and the
// partial file is removed before the rejection surfaces.
async function downloadModel(modelId, onProgress, { fetchImpl = fetch, dir = MODELS_DIR, base, manifest = null, signal = null } = {}) {
  const spec = MODEL_SPECS[modelId.toLowerCase()];
  if (!spec) throw new Error(`Unknown model: ${modelId}. Available: ${Object.keys(MODEL_SPECS).join(', ')}`);
  // `manifest` is a test seam for a fixture with a reproducible digest; in the app it
  // is always the pinned table.
  const entry = manifest || fileFor(modelId);
  if (!entry) {
    const reason = unavailableReason(modelId) || 'No published model file matches this name.';
    throw new Error(`Model ${modelId} cannot be downloaded: ${reason}`);
  }

  ensureDir(dir);
  const cachePath = path.join(dir, `${modelId}.bin`);
  const indexPath = path.join(dir, `${modelId}.idx`);
  const partialPath = `${cachePath}.part`;

  // Check if model already exists and matches the pinned digest.
  if (fs.existsSync(cachePath)) {
    if (sha256File(cachePath) === entry.sha256) {
      return { path: cachePath, spec, sha256: entry.sha256 };
    }
    // Wrong bytes on disk: it is not the published model, so it does not stay.
    try { fs.unlinkSync(cachePath); } catch {}
    try { fs.unlinkSync(indexPath); } catch {}
  }
  try { fs.unlinkSync(partialPath); } catch {}
  if (signal && signal.aborted) throw abortError(`Download for ${modelId} was aborted`);

  const url = downloadUrl(modelId, base);
  const hash = crypto.createHash('sha256');
  let received = 0;
  let fd = null;

  try {
    const res = await fetchImpl(url, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`Failed to download model: ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get('content-length') || '0') || entry.bytes;

    fd = fs.openSync(partialPath, 'w', 0o600);
    for await (const chunk of res.body) {
      if (signal && signal.aborted) throw abortError(`Download for ${modelId} was aborted`);
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > entry.bytes) {
        throw new Error(`Download for ${modelId} exceeded its expected size of ${entry.bytes} bytes`);
      }
      hash.update(buf);
      fs.writeSync(fd, buf);
      if (onProgress && total > 0) onProgress(Math.min(received / total, 1));
    }
    if (signal && signal.aborted) throw abortError(`Download for ${modelId} was aborted`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    if (received !== entry.bytes) {
      throw new Error(`Download for ${modelId} was ${received} bytes, expected ${entry.bytes}`);
    }
    const digest = hash.digest('hex');
    if (digest !== entry.sha256) {
      throw new Error(`Download for ${modelId} did not match its published SHA-256`);
    }

    fs.renameSync(partialPath, cachePath);
    try { fs.chmodSync(cachePath, 0o600); } catch {}
    await fs.promises.writeFile(
      indexPath,
      JSON.stringify({ sha256: entry.sha256, model: modelId, file: entry.file, bytes: entry.bytes }),
      { mode: 0o600 },
    );
    return { path: cachePath, spec, sha256: entry.sha256 };
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(partialPath); } catch {}
    try { fs.unlinkSync(indexPath); } catch {}
    if (error && error.name === 'AbortError') throw error;
    if (signal && signal.aborted) throw abortError(`Download for ${modelId} was aborted`);
    throw new Error(`Failed to download model ${modelId}: ${error.message}`);
  }
}

// Verify a model's SHA-256 hash
function verifyModel(modelId, expectedSha256) {
  const cachePath = modelCachePath(modelId);
  if (!fs.existsSync(cachePath)) return { valid: false, error: 'Model file not found' };
  const actual = sha256File(cachePath);
  return { valid: actual === expectedSha256, actual };
}

// Build the multipart body for the whisper.cpp server /inference endpoint.
// A non-empty language code is forwarded as a `language` form field so local
// transcription honors the selected language; empty means auto-detection.
// Temperature is a request field, not a server startup flag: whisper-server
// v1.9.5 has no `--temp` option (passing it aborts startup), but it does read
// `temperature` from this multipart body. 0.0 keeps decoding deterministic.
function buildInferenceBody(pcmBuffer, language = '') {
  const boundary = `volyx-${crypto.randomBytes(16).toString('hex')}`;
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`, 'utf8'),
    pcmBuffer,
    Buffer.from('\r\n', 'utf8'),
  ];
  const normalizedLanguage = normalizeWhisperLanguage(language);
  if (normalizedLanguage) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${normalizedLanguage}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0.0\r\n`, 'utf8'));
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(parts) };
}

// Version of whisper.cpp the runtime-provisioned binaries directory maps to.
// The release comes from the pinned runtime manifest so provisioning and the
// sidecar can never disagree about which directory holds the binary.
const PROVISIONED_BINARY_VERSION = RELEASE_VERSION;

// The whisper-server argument contract. Kept separate from start() so it can be
// asserted without spawning a process; the pinned v1.9.5 server rejects unknown
// options (notably `--temp`), so only options listed in its --help belong here.
function buildServerArgs({ modelPath, host = '127.0.0.1', port, threads = 1 } = {}) {
  if (typeof modelPath !== 'string' || !modelPath) throw new Error('buildServerArgs requires a modelPath');
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error(`buildServerArgs requires a valid TCP port, received ${port}`);
  }
  const numericThreads = Number(threads);
  if (!Number.isInteger(numericThreads) || numericThreads < 1) {
    throw new Error(`buildServerArgs requires a positive thread count, received ${threads}`);
  }
  return [
    '-m', modelPath,
    '--host', host,
    '--port', String(numericPort),
    '--threads', String(numericThreads),
  ];
}

// Resolve the whisper.cpp server binary used by the sidecar.
// Precedence: VOLYX_LENS_WHISPER_SIDECAR_BIN env var, then the runtime
// provisioned binaries directory (userData/whisper-binaries/<version>), then a
// bundled resources/native/whisper-server binary when packaging ships one.
// Fails with an actionable message instead of a bare MODULE_NOT_FOUND so a
// missing binary is never surfaced as a confusing require error.
function resolveWhisperBinary({
  env = process.env,
  platform = process.platform,
  resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
  binariesDir = '',
  fsImpl = fs,
} = {}) {
  const candidates = [];
  const fromEnv = String(env.VOLYX_LENS_WHISPER_SIDECAR_BIN || '').trim();
  if (fromEnv) candidates.push({ path: fromEnv, source: 'VOLYX_LENS_WHISPER_SIDECAR_BIN' });
  if (binariesDir) candidates.push({
    path: path.join(binariesDir, platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'),
    source: 'provisioned binaries',
  });
  if (resourcesPath) candidates.push({
    path: path.join(resourcesPath, 'native', platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'),
    source: 'bundled resources',
  });
  for (const { path: candidate, source } of candidates) {
    if (isExecutableFile(candidate, platform, fsImpl)) return { binary: candidate, source };
  }
  const detail = candidates.length
    ? `Tried ${candidates.map((candidate) => `"${candidate.path}" (${candidate.source})`).join(', ')}.`
    : 'No whisper.cpp server binary source is available.';
  throw new Error(`Whisper sidecar binary not found. Set VOLYX_LENS_WHISPER_SIDECAR_BIN to the whisper-server executable, or run the binary provisioning step that downloads it into the whisper-binaries directory. ${detail}`);
}

function isExecutableFile(candidate, platform = process.platform, fsImpl = fs) {
  try {
    if (typeof candidate !== 'string' || !candidate) return false;
    // Mirror src/offline-stt.js validateOfflineConfig: resolve symlinks, require a
    // regular file, require the exec bit, and reject world-writable targets.
    // The check runs against the resolved path; the spawn uses shell:false.
    const resolved = fsImpl.realpathSync(candidate);
    const stat = fsImpl.statSync(resolved);
    if (!stat.isFile()) return false;
    // POSIX mode bits and the exec bit are meaningless on Windows: files there
    // are protected by ACLs, and Node reports emulated modes (typically 0o666,
    // which looks world-writable). Skip the checks when targeting win32, and
    // skip the world-writable rejection whenever the host OS itself is win32
    // (a darwin-targeted test running on a Windows runner must not read the
    // emulated mode bits as real permissions).
    if (platform !== 'win32') {
      fsImpl.accessSync(resolved, fsImpl.constants.X_OK);
      const hostIsWindows = typeof process !== 'undefined' && process.platform === 'win32';
      if (!hostIsWindows && (stat.mode & 0o002) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Runtime location where the app provisions whisper.cpp server binaries
// (userData/whisper-binaries/<version>). Mirrors dev/paths.js getBinariesDir
// so a binary downloaded by the provisioning step is found by the sidecar.
function defaultBinariesDir(userDataPath = getUserDataPath()) {
  return path.join(userDataPath, 'whisper-binaries', PROVISIONED_BINARY_VERSION);
}

function getUserDataPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch {}
  return path.join(os.homedir(), '.volyx-lens');
}

// WhisperSidecar class - persistent sidecar process with shared inference queue
class WhisperSidecar {
  constructor(options = {}) {
    this.modelId = options.modelId || 'base.en';
    this.modelPath = options.modelPath || null;
    this.port = options.port || 0;
    this.host = options.host || '127.0.0.1';
    this.language = normalizeWhisperLanguage(options.language);
    this.child = null;
    this._running = false;
    this._state = null;
    this.requestQueue = { you: [], them: [] };
    this.processingYou = false;
    this.processingThem = false;
    this.ontranscript = options.ontranscript || (() => {});
    this.onstate = options.onstate || (() => {});
    this.abortCtrl = null;
    this.threads = Number.isInteger(options.threads) && options.threads > 0 ? options.threads : 1;
    // large-v3 can take well over 30 s to load from a slow disk, so the default
    // startup budget is two minutes.
    this.startupTimeoutMs = Number.isFinite(options.startupTimeoutMs) && options.startupTimeoutMs >= 0
      ? options.startupTimeoutMs
      : 120000;
    this.startupPollIntervalMs = Number.isFinite(options.startupPollIntervalMs) && options.startupPollIntervalMs >= 0
      ? options.startupPollIntervalMs
      : 200;
    this.onDownloadProgress = typeof options.onDownloadProgress === 'function' ? options.onDownloadProgress : null;
    // Injection seams: the app always uses the real implementations, while tests
    // can drive download, spawn, fetch, time and port allocation deterministically.
    this._fetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
    this._downloadModel = typeof options.downloadModel === 'function' ? options.downloadModel : downloadModel;
    this._spawn = typeof options.spawn === 'function' ? options.spawn : require('child_process').spawn;
    this._resolveBinary = typeof options.resolveBinary === 'function' ? options.resolveBinary : resolveWhisperBinary;
    this._sleep = typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    this._now = typeof options.now === 'function' ? options.now : Date.now;
    // Aborts an in-flight start() (model download, port allocation, health wait).
    this._startCtrl = null;
    // Coalesces concurrent start() calls into one startup and one child.
    this._startPromise = null;
  }

  // Update the language used for subsequent transcriptions. Whisper.cpp only
  // accepts ISO 639-1 base codes, so locale-form identifiers (zh-TW) and the
  // literal "auto" are normalized here rather than sent to the sidecar.
  setLanguage(language = '') {
    this.language = normalizeWhisperLanguage(language);
    return this;
  }

  get running() { return this._running; }

  get state() { return this._state; }

  _setState(next) {
    this._state = next;
    this._running = next === 'ready' || next === 'starting';
    this.onstate(next);
  }

  // Reject and clear all pending promises in the request queue to prevent
  // memory leaks when the sidecar is stopped or unloaded.
  _rejectAndClearQueue() {
    for (const item of this.requestQueue.you) {
      item.reject(new Error('sidecar_stopped'));
    }
    for (const item of this.requestQueue.them) {
      item.reject(new Error('sidecar_stopped'));
    }
    this.requestQueue.you = [];
    this.requestQueue.them = [];
  }

  // Invalidate this instance when the whisper.cpp child dies or fails to
  // spawn, so callers see it is no longer running and spawn a replacement
  // instead of continuing to send inference requests to a dead process.
  _watchChild(child) {
    const onExit = () => {
      if (this.child === child) this.child = null;
      this._setState('idle');
    };
    child.on('exit', onExit);
    child.on('error', onExit);
  }

  // Allocate a free HTTP port by briefly binding a TCP listener on the loopback
  // interface. A UDP socket can report a port that is already taken by a TCP
  // listener, which would make whisper-server fail to bind.
  _allocatePort() {
    const net = require('net');
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, this.host, () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
  }

  _endpoint(path = '/') {
    return `http://${this.host}:${this.port}${path}`;
  }

  _assertStartAlive(controller) {
    if (controller.signal.aborted) {
      const error = new Error('Whisper sidecar start was aborted');
      error.name = 'AbortError';
      throw error;
    }
  }

  _disposeChild(child) {
    if (!child) return;
    try { child.kill(); } catch { /* already gone */ }
  }

  start() {
    if (this.running) return Promise.resolve();
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._start().finally(() => {
      this._startPromise = null;
    });
    return this._startPromise;
  }

  async _start() {
    const controller = new AbortController();
    this._startCtrl = controller;
    const signal = controller.signal;
    let child = null;

    try {
      // Load model if not already cached. The download shares the start token,
      // so stop() cancels a multi-gigabyte fetch instead of waiting it out.
      if (!this.modelPath) {
        const result = await this._downloadModel(this.modelId, this.onDownloadProgress, { signal });
        this.modelPath = (result && result.path) || modelCachePath(this.modelId);
      }
      this._assertStartAlive(controller);

      const port = this.port || await this._allocatePort();
      this.port = port;
      this._assertStartAlive(controller);

      const args = buildServerArgs({
        modelPath: this.modelPath,
        host: this.host,
        port,
        threads: this.threads,
      });

      this._setState('starting');
      const { binary: execArg } = this._resolveBinary({ binariesDir: defaultBinariesDir() });
      // Last gate before spawn: a stop() that landed while the model was
      // downloading or the port was being allocated must never leave a child.
      this._assertStartAlive(controller);

      child = this._spawn(execArg, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, PATH: process.env.PATH },
      });

      this.child = child;
      this._watchChild(child);
      let stderrAccum = '';
      let exitCode = null;
      const exited = new Promise((resolve) => {
        child.once('exit', (code) => { exitCode = code; resolve(code); });
      });

      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => {
          stderrAccum += chunk.toString();
        });
      }

      // Health check
      const healthCheck = async () => {
        try {
          const res = await this._fetch(this._endpoint('/health'));
          return res && res.ok;
        } catch {
          return false;
        }
      };

      const deadline = this._now() + this.startupTimeoutMs;
      while (this._now() < deadline) {
        this._assertStartAlive(controller);
        const ready = await healthCheck();
        this._assertStartAlive(controller);
        if (ready) {
          this._setState('ready');
          return;
        }
        // Wake as soon as the child exits instead of polling a dead process for
        // the entire startup budget. The stderr tail is the useful diagnostic.
        const exitedFirst = await Promise.race([
          this._sleep(this.startupPollIntervalMs).then(() => null),
          exited,
        ]);
        if (exitedFirst !== null) break;
      }

      const tail = stderrAccum.trim().slice(-400);
      if (exitCode !== null) {
        throw new Error(
          `Whisper sidecar exited with code ${exitCode}` + (tail ? `: ${tail}` : '.'),
        );
      }
      throw new Error('Whisper sidecar did not become ready in time' + (tail ? `: ${tail}` : ''));
    } catch (error) {
      this._disposeChild(child);
      if (this.child === child) this.child = null;
      if (this._state && this._state !== 'idle') this._setState('idle');
      throw error;
    } finally {
      if (this._startCtrl === controller) this._startCtrl = null;
    }
  }

  async stop() {
    this._rejectAndClearQueue();
    // Invalidate an in-flight start() before killing anything: the token check
    // inside start() refuses to spawn once this signal is aborted.
    if (this._startCtrl) {
      this._startCtrl.abort();
      this._startCtrl = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this._setState('idle');
    // Cancel an outstanding /inference request instead of leaving it to run
    // until its two-minute timeout.
    if (this.abortCtrl) {
      this.abortCtrl.abort();
      this.abortCtrl = null;
    }
  }

  // Queue audio for transcription (non-blocking, shared between You and Them).
  // Resolves with { text, channel, timestamp } once the sidecar transcribes it.
  // The language is captured at enqueue time so audio queued under one language
  // is not re-transcribed under a later setLanguage change.
  queueYou(pcmBuffer, language = this.language) {
    if (this.requestQueue.you.length >= 64) return Promise.reject(new Error('sidecar queue full'));
    return new Promise((resolve, reject) => {
      this.requestQueue.you.push({ pcm: pcmBuffer, channel: 'you', language, resolve, reject });
      this._tryProcess();
    });
  }

  queueThem(pcmBuffer, language = this.language) {
    if (this.requestQueue.them.length >= 64) return Promise.reject(new Error('sidecar queue full'));
    return new Promise((resolve, reject) => {
      this.requestQueue.them.push({ pcm: pcmBuffer, channel: 'them', language, resolve, reject });
      this._tryProcess();
    });
  }

  _tryProcess() {
    if (this.processingYou || this.processingThem) return;
    if (this.requestQueue.you.length > 0) {
      const item = this.requestQueue.you.shift();
      this.processingYou = true;
      this._transcribe(item.pcm, item.channel, item.language).then((text) => {
        item.resolve({ text, channel: item.channel, timestamp: Date.now() });
      }).catch((err) => {
        item.reject(err);
      }).finally(() => {
        this.processingYou = false;
        this._tryProcess();
      });
    } else if (this.requestQueue.them.length > 0) {
      const item = this.requestQueue.them.shift();
      this.processingThem = true;
      this._transcribe(item.pcm, item.channel, item.language).then((text) => {
        item.resolve({ text, channel: item.channel, timestamp: Date.now() });
      }).catch((err) => {
        item.reject(err);
      }).finally(() => {
        this.processingThem = false;
        this._tryProcess();
      });
    }
  }

  async _transcribe(pcmBuffer, channel, language = this.language) {
    if (!this.modelPath) throw new Error('No model loaded');

    const { boundary, body } = buildInferenceBody(pcmBuffer, language);

    const controller = new AbortController();
    this.abortCtrl = controller;
    const timer = setTimeout(() => controller.abort(), 120000); // 2min inference timeout

    try {
      const res = await this._fetch(this._endpoint('/inference'), {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      const data = await res.json();
      const text = String(data.text || '').trim();
      this.ontranscript({ channel, text, timestamp: Date.now() });
      return text;
    } catch (error) {
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.abortCtrl === controller) this.abortCtrl = null;
    }
  }

  // Force unload model and stop sidecar
  unload() {
    this._rejectAndClearQueue();
    if (this._startCtrl) {
      this._startCtrl.abort();
      this._startCtrl = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this._setState('idle');
    if (this.abortCtrl) {
      this.abortCtrl.abort();
      this.abortCtrl = null;
    }
    this.modelPath = null;
    this.processingYou = false;
    this.processingThem = false;
  }
}

module.exports = {
  MODEL_SPECS,
  MODELS_DIR,
  PROVISIONED_BINARY_VERSION,
  ensureDir,
  downloadModel,
  verifyModel,
  sha256File,
  buildInferenceBody,
  buildServerArgs,
  resolveWhisperBinary,
  defaultBinariesDir,
  isExecutableFile,
  WhisperSidecar,
};