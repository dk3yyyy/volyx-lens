'use strict';

// Persistent whisper.cpp server session.
//
// The CLI adapter (offline-stt.js) spawns whisper-cli once per utterance, so
// every transcript pays the model-load cost (~1-2 s for base.en, far more for
// larger models). A dedicated meeting produces dozens of utterances — the
// load is pure waste.
//
// This module supervises one whisper-server process for an entire capture
// session: it finds a free loopback port, waits for the server to become
// healthy (model loaded), then transcribes WAV buffers over HTTP. The process
// is started lazily, kept alive across utterances, and torn down on stop.
// Conceived from the same problem other open-source meeting copilots solve,
// but implemented our own way: health-polled startup, bounded stderr capture,
// abortable inference requests, and a supervised stop that escalates
// SIGTERM -> SIGKILL.

const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const LOOPBACK_HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 120000; // first model load can be slow for large models
const HEALTH_POLL_MS = 150;
const INFERENCE_TIMEOUT_MS = 120000;
const STOP_GRACE_MS = 3000;
const MAX_STDERR_TAIL = 12000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Ask the OS for a free port on the loopback interface. */
function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'number') return reject(new Error('Could not allocate a loopback port.'));
        resolve(address.port);
      });
    });
  });
}

/**
 * Build the multipart form body for whisper.cpp's /inference endpoint.
 * Whisper 1.9.x responds to /inference (the OpenAI-compatible route is newer);
 * verified against whisper-cpp 1.9.2. temperature is pinned to 0 for
 * deterministic output, matching the batch CLI path.
 */
function buildInferenceBody(wav, { language = '', prompt = '' } = {}) {
  const boundary = `volyx-${crypto.randomBytes(16).toString('hex')}`;
  const parts = [];
  const field = (name, value) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'
  );
  parts.push(field('response_format', 'json'));
  parts.push(field('temperature', '0.0'));
  if (language) parts.push(field('language', language));
  if (prompt) parts.push(field('prompt', prompt));
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`, 'utf8'
  ));
  parts.push(Buffer.isBuffer(wav) ? wav : Buffer.from(wav));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(parts) };
}

class WhisperServerSession {
  /**
   * @param {object} options
   * @param {string} options.executable       whisper-server binary path
   * @param {string} options.modelPath        GGML model path
   * @param {string} [options.language='']    language hint ("en", ...)
   * @param {string} [options.prompt='']      default initial-prompt seed
   * @param {number}  [options.threads=0]     0 = server default
   * @param {string} [options.host=LOOPBACK_HOST]
   * @param {number}  [options.port=0]        0 = allocate a free loopback port
   * @param {Function} [options.spawnImpl]     injectable spawn for tests
   * @param {Function} [options.fetchImpl]     injectable fetch for tests
   * @param {Function} [options.wait]          injectable delay for tests
   * @param {Function} [options.findPort]      injectable port allocator
   * @param {Function} [options.onState]       state callback for diagnostics
   */
  constructor({
    executable,
    modelPath,
    language = '',
    prompt = '',
    threads = 0,
    host = LOOPBACK_HOST,
    port = 0,
    spawnImpl = spawn,
    fetchImpl = global.fetch,
    wait = delay,
    findPort = findFreeLoopbackPort,
    onState = () => {},
  }) {
    if (!executable || !modelPath) throw new Error('WhisperServerSession requires an executable and model path.');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch-compatible implementation is required.');
    this.executable = executable;
    this.modelPath = modelPath;
    this.language = language;
    this.prompt = prompt;
    this.threads = threads;
    this.host = host;
    this.port = port;
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.wait = wait;
    this.findPort = findPort;
    this.onState = onState;
    this.child = null;
    this.state = 'idle'; // idle | starting | ready | stopped
  }

  get running() {
    return this.state === 'ready';
  }

  _setState(next) {
    this.state = next;
    this.onState(next);
  }

  _endpoint(path = '/') {
    return `http://${this.host}:${this.port}${path}`;
  }

  async start() {
    if (this.state === 'starting' || this.state === 'ready') return;
    if (this.child) { await this.stop(); }
    if (!this.port) this.port = await this.findPort();

    const args = ['-m', this.modelPath, '--host', this.host, '--port', String(this.port)];
    if (Number.isInteger(this.threads) && this.threads > 0) args.push('-t', String(this.threads));

    this._setState('starting');
    const child = this.spawnImpl(this.executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let stderrTail = '';
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-MAX_STDERR_TAIL); });
    // If the process dies while we are ready (crash), fail fast instead of
    // serving transcript errors into the session.
    child.once('close', () => { if (this.state === 'ready') this._setState('stopped'); });

    const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)));
    let exitCode = null;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const raced = await Promise.race([
        exited.then((code) => ({ type: 'exit', code })),
        this.wait(HEALTH_POLL_MS).then(() => ({ type: 'poll' })),
      ]);
      if (raced.type === 'exit') { exitCode = raced.code; break; }
      try {
        const res = await this.fetchImpl(this._endpoint('/'));
        if (res && res.ok !== false) { this._setState('ready'); return; }
      } catch { /* not up yet */ }
    }
    this._setState('stopped');
    this.child = null;
    const tail = stderrTail.trim().slice(-400);
    throw new Error(
      `Whisper server did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s` +
      (exitCode !== null ? ` (process exited with code ${exitCode})` : '') +
      (tail ? `: ${tail}` : '.')
    );
  }

  /**
   * Transcribe one WAV buffer via the /inference endpoint.
   * Returns the trimmed transcript text. Errors carry a stable code:
   * whisper_session_lost (connection broken, session unusable) or
   * whisper_http_error (server responded with an error status).
   */
  async transcribe(wav, { language = this.language, prompt = this.prompt } = {}) {
    if (this.state !== 'ready' || !this.child) {
      const error = new Error('Whisper server is not ready.');
      error.code = 'whisper_session_lost';
      throw error;
    }
    const { boundary, body } = buildInferenceBody(wav, { language, prompt });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);
    let res;
    try {
      res = await this.fetchImpl(this._endpoint('/inference'), {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      this._setState('stopped');
      const lost = new Error(`Whisper server connection lost: ${error && error.message ? error.message : String(error)}`);
      lost.code = 'whisper_session_lost';
      throw lost;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const http = new Error(`Whisper server returned HTTP ${res.status}.`);
      http.code = 'whisper_http_error';
      http.status = res.status;
      throw http;
    }
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON body */ }
    return String((payload && payload.text) || '').trim();
  }

  /** Stop the server: SIGTERM, escalate to SIGKILL after the grace period. Idempotent. */
  async stop() {
    const child = this.child;
    this.child = null;
    if (this.state === 'starting' || this.state === 'ready') this._setState('stopped');
    if (!child) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const winner = await Promise.race([closed.then(() => 'closed'), this.wait(STOP_GRACE_MS).then(() => 'timeout')]);
    if (winner === 'timeout' && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (winner === 'timeout') await closed.catch(() => {});
  }
}

module.exports = { WhisperServerSession, findFreeLoopbackPort, buildInferenceBody };
