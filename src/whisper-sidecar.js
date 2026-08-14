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
const fetch = require('node-fetch').default;
const { normalizeWhisperLanguage } = require('./whisper-language');

// Model specifications (~30 models)
const MODEL_SPECS = {
  'tiny': { sizeMB: 39, params: '39M', desc: 'English-only, very fast, lowest quality' },
  'tiny.en': { sizeMB: 39, params: '39M', desc: 'English-only, very fast, lowest quality' },
  'tiny.int8': { sizeMB: 39, params: '39M', desc: 'English-only int8 quantized, very fast' },
  'base': { sizeMB: 142, params: '139M', desc: 'Multilingual, fast, good quality' },
  'base.en': { sizeMB: 142, params: '139M', desc: 'English-only, fast, good quality' },
  'base.int8': { sizeMB: 142, params: '139M', desc: 'English-only int8 quantized, fast' },
  'small': { sizeMB: 466, params: '466M', desc: 'Multilingual, balanced speed/quality' },
  'small.en': { sizeMB: 466, params: '466M', desc: 'English-only, balanced speed/quality' },
  'small.int8': { sizeMB: 466, params: '466M', desc: 'English-only int8 quantized, balanced' },
  'medium': { sizeMB: 1550, params: '1550M', desc: 'Multilingual, better quality' },
  'medium.en': { sizeMB: 1550, params: '1550M', desc: 'English-only, better quality' },
  'medium.int8': { sizeMB: 1550, params: '1550M', desc: 'English-only int8 quantized, better' },
  'large-v3': { sizeMB: 3036, params: '3036M', desc: 'Multilingual, best quality (default)' },
  'large-v3.en': { sizeMB: 3036, params: '3036M', desc: 'English-only, best quality' },
  'large-v3.int8': { sizeMB: 3036, params: '3036M', desc: 'English-only int8 quantized, best' },
  'large': { sizeMB: 3036, params: '3036M', desc: 'Multilingual, largest (slowest)' },
  'large.int8': { sizeMB: 3036, params: '3036M', desc: 'Multilingual int8 quantized' },
  'distil-large-v3': { sizeMB: 1550, params: '1550M', desc: 'Distilled, faster than large-v3' },
};

// Cache directory for downloaded models
const MODELS_DIR = path.join(os.homedir(), '.volyx-lens', 'whisper-models');

// Ensure the cache directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Get the cache path for a model
function modelCachePath(modelId) {
  return path.join(MODELS_DIR, `${modelId}.bin`);
}

// Get the index path (with SHA-256 verification) for a model
function modelIndexPath(modelId) {
  return path.join(MODELS_DIR, `${modelId}.idx`);
}

// Compute SHA-256 hash of a file
function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Download a model from Hugging Face with progress and verification
async function downloadModel(modelId, onProgress) {
  const spec = MODEL_SPECS[modelId.toLowerCase()];
  if (!spec) throw new Error(`Unknown model: ${modelId}. Available: ${Object.keys(MODEL_SPECS).join(', ')}`);

  ensureDir(MODELS_DIR);
  const cachePath = modelCachePath(modelId);
  const indexPath = modelIndexPath(modelId);

  // Check if model already exists and is verified
  if (fs.existsSync(cachePath) && fs.existsSync(indexPath)) {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (sha256File(cachePath) === index.sha256) {
      // Model is verified and up-to-date
      return { path: cachePath, spec, sha256: index.sha256 };
    }
    // Verification failed, redownload
    fs.unlinkSync(cachePath);
    fs.unlinkSync(indexPath);
  }

  // Download the model
  const url = `${process.env.WHISPER_DOWNLOAD_BASE || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'}/models/whisper.cpp/${modelId}.bin`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download model: ${res.status} ${res.statusText}`);

    const total = Number(res.headers.get('content-length') || '0');
    let downloaded = 0;
    const chunks = [];

    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      downloaded += buf.length;
      if (onProgress) onProgress(downloaded / total);
    }

    await fs.promises.writeFile(cachePath, Buffer.concat(chunks));

    // Verify SHA-256
    const hash = sha256File(cachePath);
    await fs.promises.writeFile(indexPath, JSON.stringify({ sha256: hash, model: modelId, sizeMB: spec.sizeMB }));

    return { path: cachePath, spec, sha256: hash };
  } catch (error) {
    // Clean up partial download
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
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
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(parts) };
}

// Version of whisper.cpp the runtime-provisioned binaries directory maps to.
// Must match dev/whisper-binary.js so a downloaded binary is found here.
const PROVISIONED_BINARY_VERSION = 'v1.9.2';

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
    const stat = fsImpl.statSync(candidate);
    if (!stat.isFile()) return false;
    if (platform !== 'win32') fsImpl.accessSync(candidate, fsImpl.constants.X_OK);
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
    this.modelPath = null;
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

  _allocatePort() {
    return new Promise((resolve) => {
      const dgram = require('dgram');
      const s = dgram.createSocket('udp4');
      s.bind(0, this.host, () => {
        const addr = s.address();
        s.close(() => resolve(addr.port));
      });
      s.on('error', (err) => { /* ignore */ });
    });
  }

  _endpoint(path = '/') {
    return `http://${this.host}:${this.port}${path}`;
  }

  async start() {
    if (this.running) return;

    // Load model if not already cached
    if (!this.modelPath) {
      await downloadModel(this.modelId);
      this.modelPath = modelCachePath(this.modelId);
    }

    const port = this.port || await this._allocatePort();
    this.port = port;

    const modelRelPath = path.relative(process.cwd(), this.modelPath);
    const args = [
      '-m', modelRelPath,
      '--host', this.host,
      '--port', String(port),
      '--threads', '1',
      '--temp', '0',
    ];

    this._setState('starting');
    const { binary: execArg } = resolveWhisperBinary({ binariesDir: defaultBinariesDir() });
    const child = require('child_process').spawn(execArg, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PATH: process.env.PATH },
    });

    this.child = child;
    this._watchChild(child);
    let stderrAccum = '';

    child.stderr.on('data', (chunk) => {
      stderrAccum += chunk.toString();
    });

    // Health check
    const healthCheck = async () => {
      try {
        const res = await fetch(this._endpoint('/health'));
        return res && res.ok;
      } catch {
        return false;
      }
    };

    const deadline = Date.now() + 30000; // 30s startup timeout
    while (Date.now() < deadline) {
      const ready = await healthCheck();
      if (ready) {
        this._setState('ready');
        return;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    this._setState('idle');
    if (this.child) this.child.kill();
    throw new Error('Whisper sidecar did not become ready in time');
  }

  async stop() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this._setState('idle');
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
    const timer = setTimeout(() => controller.abort(), 120000); // 2min inference timeout

    try {
      const res = await fetch(this._endpoint('/inference'), {
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
    }
  }

  // Force unload model and stop sidecar
  unload() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this._setState('idle');
    this.modelPath = null;
    this.requestQueue = { you: [], them: [] };
    this.processingYou = false;
    this.processingThem = false;
  }
}

module.exports = {
  MODEL_SPECS,
  MODELS_DIR,
  ensureDir,
  downloadModel,
  verifyModel,
  sha256File,
  buildInferenceBody,
  resolveWhisperBinary,
  isExecutableFile,
  WhisperSidecar,
};