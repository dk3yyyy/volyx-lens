const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAGIC = Buffer.from('VLAU');
const PROTOCOL_VERSION = 1;
const TYPE_EVENT = 1;
const TYPE_PCM = 2;
const HEADER_BYTES = 16;
const MAX_PAYLOAD_BYTES = 65536;
const MAX_RECEIVE_BYTES = 131072;
const MAX_STDERR_BYTES = 65536;
const READY_TIMEOUT_MS = 10000;
const ALLOWED_EVENTS = new Set(['starting', 'ready', 'level', 'dropped', 'stopped', 'error']);
const ALLOWED_ERRORS = new Set(['unsupported_os', 'permission_denied', 'no_display', 'stream_start_failed', 'stream_stopped', 'audio_format_failed', 'stdout_failed', 'internal_error']);

function resolveSystemAudioHelper({ app = null, resourcesPath = process.resourcesPath, projectDir = path.resolve(__dirname, '..') } = {}) {
  return app && app.isPackaged
    ? path.join(resourcesPath, 'native', 'volyx-lens-system-audio')
    : path.join(projectDir, 'native-bin', 'volyx-lens-system-audio');
}

function validateSystemAudioHelper(helperPath, platform = process.platform) {
  if (platform !== 'darwin') return { ready: false, reason: 'unsupported_platform' };
  try {
    const resolved = fs.realpathSync(helperPath);
    const stat = fs.statSync(resolved);
    fs.accessSync(resolved, fs.constants.X_OK);
    if (!stat.isFile() || (stat.mode & 0o002)) return { ready: false, reason: 'unsafe_helper' };
    return { ready: true, helper: resolved };
  } catch {
    return { ready: false, reason: 'helper_missing' };
  }
}

function parseFrames(state, chunk, handlers) {
  state.buffer = Buffer.concat([state.buffer, Buffer.from(chunk)]);
  if (state.buffer.length > MAX_RECEIVE_BYTES) throw new Error('protocol_overflow');
  while (state.buffer.length >= HEADER_BYTES) {
    if (!state.buffer.subarray(0, 4).equals(MAGIC)) throw new Error('protocol_magic');
    const version = state.buffer.readUInt8(4);
    const type = state.buffer.readUInt8(5);
    const flags = state.buffer.readUInt16BE(6);
    const length = state.buffer.readUInt32BE(8);
    const sequence = state.buffer.readUInt32BE(12);
    if (version !== PROTOCOL_VERSION || flags !== 0 || length > MAX_PAYLOAD_BYTES || ![TYPE_EVENT, TYPE_PCM].includes(type)) throw new Error('protocol_header');
    if (state.buffer.length < HEADER_BYTES + length) return;
    if (state.lastSequence !== null && sequence !== ((state.lastSequence + 1) >>> 0)) throw new Error('protocol_sequence');
    state.lastSequence = sequence;
    const payload = state.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
    state.buffer = state.buffer.subarray(HEADER_BYTES + length);
    if (type === TYPE_EVENT) {
      let event;
      try { event = JSON.parse(payload.toString('utf8')); } catch { throw new Error('protocol_event'); }
      if (!event || !ALLOWED_EVENTS.has(event.event)) throw new Error('protocol_event');
      handlers.onEvent(event);
      continue;
    }
    if (!state.ready || !payload.length || payload.length > 4096 || payload.length % 2) throw new Error('protocol_pcm');
    handlers.onPcm(Buffer.from(payload));
  }
}

function createSystemAudioCapture({
  platform = process.platform,
  helperPath,
  app = null,
  resourcesPath = process.resourcesPath,
  projectDir = path.resolve(__dirname, '..'),
  spawnImpl = spawn,
  onPcm = () => {},
  onState = () => {},
  onUnexpectedExit = () => {},
  readyTimeoutMs = READY_TIMEOUT_MS,
} = {}) {
  const resolvedPath = helperPath || resolveSystemAudioHelper({ app, resourcesPath, projectDir });
  let child = null;
  let generation = 0;
  let startPromise = null;
  let intentionalStop = false;
  let ready = false;

  function availability() {
    const result = validateSystemAudioHelper(resolvedPath, platform);
    return { available: result.ready, engine: result.ready ? 'screencapturekit' : null, reason: result.ready ? null : result.reason };
  }

  async function start() {
    if (ready && child) return { ok: true };
    if (startPromise) return startPromise;
    const config = validateSystemAudioHelper(resolvedPath, platform);
    if (!config.ready) return { ok: false, reason: config.reason };
    const myGeneration = ++generation;
    intentionalStop = false;
    onState({ state: 'connecting' });
    startPromise = new Promise((resolve) => {
      let settled = false;
      let stderrBytes = 0;
      const parser = { buffer: Buffer.alloc(0), lastSequence: null, ready: false };
      const finishStart = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      try {
        child = spawnImpl(config.helper, ['--capture'], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '', LANG: process.env.LANG || 'en_US.UTF-8' },
        });
      } catch {
        child = null;
        onState({ state: 'failed', reason: 'spawn_failed' });
        finishStart({ ok: false, reason: 'spawn_failed' });
        return;
      }
      const activeChild = child;
      const protocolFailure = () => {
        onState({ state: 'failed', reason: 'protocol_error' });
        activeChild.kill('SIGKILL');
        finishStart({ ok: false, reason: 'protocol_error' });
      };
      activeChild.stdout.on('data', (chunk) => {
        if (myGeneration !== generation) return;
        try {
          parseFrames(parser, chunk, {
            onPcm,
            onEvent: (event) => {
              if (event.event === 'ready') {
                const format = event.format || {};
                if (format.encoding !== 's16le' || format.sampleRate !== 24000 || format.channels !== 1 || format.frameSamples !== 480) return protocolFailure();
                parser.ready = true;
                ready = true;
                onState({ state: 'connected' });
                finishStart({ ok: true });
              } else if (event.event === 'error') {
                const reason = ALLOWED_ERRORS.has(event.code) ? event.code : 'internal_error';
                onState({ state: 'failed', reason });
                if (event.fatal === true) {
                  activeChild.kill('SIGTERM');
                  finishStart({ ok: false, reason });
                }
              } else if (event.event === 'stopped') {
                onState({ state: 'stopped' });
              }
            },
          });
        } catch { protocolFailure(); }
      });
      activeChild.stderr.on('data', (chunk) => { stderrBytes = Math.min(MAX_STDERR_BYTES, stderrBytes + chunk.length); });
      activeChild.once('error', () => {
        ready = false;
        onState({ state: 'failed', reason: 'spawn_failed' });
        finishStart({ ok: false, reason: 'spawn_failed' });
      });
      activeChild.once('close', (code, signal) => {
        const wasIntentional = intentionalStop || myGeneration !== generation;
        if (child === activeChild) child = null;
        ready = false;
        if (!settled) finishStart({ ok: false, reason: stderrBytes ? 'helper_reported_error' : 'helper_exit' });
        if (!wasIntentional) {
          onState({ state: 'failed', reason: 'helper_exit' });
          onUnexpectedExit({ code: Number.isInteger(code) ? code : null, signal: signal || null });
        }
      });
      activeChild.stdin.once('error', () => {});
      const timer = setTimeout(() => {
        if (settled) return;
        onState({ state: 'failed', reason: 'ready_timeout' });
        activeChild.kill('SIGKILL');
        finishStart({ ok: false, reason: 'ready_timeout' });
      }, Math.max(1000, Math.min(30000, Number(readyTimeoutMs) || READY_TIMEOUT_MS)));
      if (timer.unref) timer.unref();
    }).finally(() => { startPromise = null; });
    return startPromise;
  }

  async function stop({ immediate = false } = {}) {
    generation += 1;
    intentionalStop = true;
    ready = false;
    const activeChild = child;
    child = null;
    if (!activeChild) { onState({ state: 'stopped' }); return; }
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(termTimer); clearTimeout(killTimer); resolve(); } };
      activeChild.once('close', finish);
      if (!immediate && activeChild.stdin && !activeChild.stdin.destroyed) {
        try { activeChild.stdin.end('{"command":"stop"}\n'); } catch {}
      } else activeChild.kill('SIGTERM');
      const termTimer = setTimeout(() => activeChild.kill('SIGTERM'), immediate ? 0 : 2000);
      const killTimer = setTimeout(() => { activeChild.kill('SIGKILL'); finish(); }, immediate ? 1000 : 3000);
      if (termTimer.unref) termTimer.unref();
      if (killTimer.unref) killTimer.unref();
    });
    onState({ state: 'stopped' });
  }

  return { availability, start, stop, isActive: () => Boolean(child && ready), helperPath: resolvedPath };
}

module.exports = { MAGIC, PROTOCOL_VERSION, TYPE_EVENT, TYPE_PCM, HEADER_BYTES, MAX_PAYLOAD_BYTES, parseFrames, resolveSystemAudioHelper, validateSystemAudioHelper, createSystemAudioCapture };
