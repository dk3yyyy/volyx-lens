const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_TEXT_CHARACTERS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('invalid_image');
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
  if (!match) throw new Error('invalid_image');
  const image = Buffer.from(match[1].replace(/[\r\n]/g, ''), 'base64');
  if (!image.length || image.length > MAX_IMAGE_BYTES) throw new Error('invalid_image');
  return image;
}

function resolveVisionHelper({ app = null, resourcesPath = process.resourcesPath, projectDir = path.resolve(__dirname, '..') } = {}) {
  return app && app.isPackaged
    ? path.join(resourcesPath, 'native', 'volyx-lens-vision-ocr')
    : path.join(projectDir, 'native-bin', 'volyx-lens-vision-ocr');
}

function validateVisionHelper(helperPath, platform = process.platform) {
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

function cleanText(value) {
  return String(value || '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, MAX_TEXT_CHARACTERS);
}

function runVisionHelper({ helper, image, spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS, activeChildren = new Map(), jobState = { cancelled: false } }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(helper, [], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: process.env.HOME || '',
          LANG: process.env.LANG || 'en_US.UTF-8',
        },
      });
    } catch {
      resolve({ status: 'unavailable', reason: 'spawn_failed' });
      return;
    }
    activeChildren.set(child, jobState);
    let stdout = Buffer.alloc(0);
    let stdoutOversized = false;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve(result);
    };
    child.stdout.on('data', (chunk) => {
      if (stdoutOversized) return;
      if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
        stdoutOversized = true;
        child.kill('SIGKILL');
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk) => { stderrBytes = Math.min(65536, stderrBytes + chunk.length); });
    child.once('error', () => finish({ status: 'unavailable', reason: 'spawn_failed' }));
    child.once('close', (code) => {
      if (jobState.cancelled) return finish({ status: 'cancelled' });
      if (timedOut) return finish({ status: 'failed', reason: 'timeout' });
      if (stdoutOversized) return finish({ status: 'failed', reason: 'output_oversized' });
      if (code !== 0) return finish({ status: 'failed', reason: stderrBytes ? 'helper_reported_error' : 'helper_exit' });
      try {
        const payload = JSON.parse(stdout.toString('utf8'));
        if (!payload || payload.ok !== true || typeof payload.text !== 'string') return finish({ status: 'failed', reason: 'invalid_output' });
        return finish({ status: 'ready', text: cleanText(payload.text), truncated: payload.truncated === true || payload.text.length > MAX_TEXT_CHARACTERS });
      } catch {
        return finish({ status: 'failed', reason: 'invalid_output' });
      }
    });
    child.stdin.once('error', () => {});
    child.stdin.end(image);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1000, Math.min(60000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)));
    if (timer.unref) timer.unref();
  });
}

function createLocalOcr({
  platform = process.platform,
  helperPath,
  app = null,
  resourcesPath = process.resourcesPath,
  projectDir = path.resolve(__dirname, '..'),
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const resolvedPath = helperPath || resolveVisionHelper({ app, resourcesPath, projectDir });
  const activeChildren = new Map();
  const pendingJobs = new Set();
  const queuedJobs = [];
  let generation = 0;
  let running = false;

  function availability() {
    const config = validateVisionHelper(resolvedPath, platform);
    return { available: config.ready, engine: config.ready ? 'macos-vision' : null, reason: config.ready ? null : config.reason };
  }

  async function pump() {
    if (running) return;
    const queued = queuedJobs.shift();
    if (!queued) return;
    running = true;
    pendingJobs.add(queued.state);
    let result;
    if (queued.state.cancelled || queued.generation !== generation) {
      result = { status: 'cancelled' };
    } else {
      const config = validateVisionHelper(resolvedPath, platform);
      if (!config.ready) {
        result = { status: 'unavailable', reason: config.reason };
      } else {
        let image;
        try { image = decodeImageDataUrl(queued.dataUrl); }
        catch { result = { status: 'failed', reason: 'invalid_image' }; }
        if (image) result = await runVisionHelper({ helper: config.helper, image, spawnImpl, timeoutMs, activeChildren, jobState: queued.state });
      }
    }
    pendingJobs.delete(queued.state);
    running = false;
    queued.resolve(result);
    setImmediate(pump);
  }

  function recognize(dataUrl, { jobId = null } = {}) {
    return new Promise((resolve) => {
      queuedJobs.push({ dataUrl, resolve, generation, state: { cancelled: false, jobId } });
      pump();
    });
  }

  function cancel(jobId) {
    if (!jobId) return false;
    let cancelled = false;
    for (let index = queuedJobs.length - 1; index >= 0; index -= 1) {
      if (queuedJobs[index].state.jobId !== jobId) continue;
      const [queued] = queuedJobs.splice(index, 1);
      queued.state.cancelled = true;
      queued.resolve({ status: 'cancelled' });
      cancelled = true;
    }
    for (const [child, state] of activeChildren) {
      if (state.jobId !== jobId) continue;
      state.cancelled = true;
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (activeChildren.has(child)) child.kill('SIGKILL');
      }, 1000);
      if (timer.unref) timer.unref();
      cancelled = true;
    }
    return cancelled;
  }

  function cancelAll() {
    generation += 1;
    while (queuedJobs.length) {
      const queued = queuedJobs.shift();
      queued.state.cancelled = true;
      queued.resolve({ status: 'cancelled' });
    }
    for (const state of pendingJobs) state.cancelled = true;
    for (const [child, state] of activeChildren) {
      state.cancelled = true;
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (activeChildren.has(child)) child.kill('SIGKILL');
      }, 1000);
      if (timer.unref) timer.unref();
    }
  }

  return { availability, recognize, cancel, cancelAll, helperPath: resolvedPath };
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_STDOUT_BYTES,
  MAX_TEXT_CHARACTERS,
  DEFAULT_TIMEOUT_MS,
  decodeImageDataUrl,
  resolveVisionHelper,
  validateVisionHelper,
  runVisionHelper,
  createLocalOcr,
};
