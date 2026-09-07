// Linux system-audio (Them) capture through the PulseAudio/PipeWire default
// sink monitor. Chromium does not implement loopback audio on Linux, so the
// renderer getDisplayMedia path cannot produce a system-audio track here.
// Instead a parec child records the default sink's monitor source and the raw
// stereo s16le stream is downmixed to the pipeline's mono 24 kHz format.
//
// Best-effort by nature: requires PulseAudio or PipeWire with pactl and parec
// on PATH, and an active default sink. Failure is reported with an actionable
// reason and never crashes the session.
const { spawn } = require('node:child_process');

const CHUNK_MS = 20;
const SAMPLE_RATE = 24000;
// 20 ms of mono s16le at 24 kHz = 480 samples * 2 bytes.
const MONO_BYTES_PER_CHUNK = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;
const STEREO_BYTES_PER_CHUNK = MONO_BYTES_PER_CHUNK * 2;
const DEFAULT_READY_TIMEOUT_MS = 10000;

function parseDefaultSink(output) {
  const line = String(output || '').split('\n').map((entry) => entry.trim()).find(Boolean);
  return line || null;
}

// Only the monitor that belongs to the requested sink is a valid capture
// source. Falling back to any *.monitor could record the wrong sink's audio
// (for example an HDMI output while the default is headphones).
function findMonitorSource(listOutput, sinkName) {
  const wanted = sinkName ? `${sinkName}.monitor` : null;
  if (!wanted) return null;
  for (const line of String(listOutput || '').split('\n')) {
    const name = String(line.split('\t')[1] || '').trim();
    if (name === wanted) return name;
  }
  return null;
}

function downmixStereoPcm(stereo) {
  const mono = Buffer.alloc(stereo.length / 2);
  for (let index = 0; index < stereo.length; index += 4) {
    const left = stereo.readInt16LE(index);
    const right = stereo.readInt16LE(index + 2);
    mono.writeInt16LE(Math.round((left + right) / 2), index / 2);
  }
  return mono;
}

function createLinuxMonitorCapture({
  platform = process.platform,
  spawnImpl = spawn,
  onPcm = () => {},
  onState = () => {},
  onUnexpectedExit = () => {},
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
} = {}) {
  let child = null;
  let generation = 0;
  let startPromise = null;
  let intentionalStop = false;
  let ready = false;

  function availability() {
    if (platform !== 'linux') return { available: false, reason: 'unsupported_platform' };
    return { available: true };
  }

  // Runs one pactl discovery command. Bounded by readyTimeoutMs so a hung
  // audio server cannot leave start() pending forever.
  function runTool(command, args, timeoutMs) {
    return new Promise((resolve) => {
      let collected = Buffer.alloc(0);
      let settled = false;
      let processHandle;
      try {
        processHandle = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        resolve({ ok: false, reason: error && error.code === 'ENOENT' ? 'tool_missing' : 'spawn_failed' });
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { processHandle.kill('SIGKILL'); } catch {}
        resolve({ ok: false, reason: 'ready_timeout' });
      }, timeoutMs);
      processHandle.stdout.on('data', (chunk) => { collected = Buffer.concat([collected, Buffer.from(chunk)]); });
      processHandle.stderr.resume();
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      processHandle.on('error', (error) => {
        finish({ ok: false, reason: error && error.code === 'ENOENT' ? 'tool_missing' : 'spawn_failed' });
      });
      processHandle.on('close', (code) => {
        if (code !== 0) finish({ ok: false, reason: 'tool_error' });
        else finish({ ok: true, stdout: collected.toString('utf8') });
      });
    });
  }

  async function start() {
    if (ready && child) return { ok: true };
    if (startPromise) return startPromise;
    if (platform !== 'linux') return { ok: false, reason: 'unsupported_platform' };
    const myGeneration = ++generation;
    intentionalStop = false;
    onState({ state: 'connecting' });
    startPromise = (async () => {
      const sinkResult = await runTool('pactl', ['get-default-sink'], readyTimeoutMs);
      if (!sinkResult.ok) return { ok: false, reason: sinkResult.reason };
      if (myGeneration !== generation) return { ok: false, reason: 'superseded' };
      const sinkName = parseDefaultSink(sinkResult.stdout);
      if (!sinkName) return { ok: false, reason: 'no_default_sink' };
      const sourcesResult = await runTool('pactl', ['list', 'short', 'sources'], readyTimeoutMs);
      if (!sourcesResult.ok) return { ok: false, reason: sourcesResult.reason };
      if (myGeneration !== generation) return { ok: false, reason: 'superseded' };
      const monitor = findMonitorSource(sourcesResult.stdout, sinkName);
      if (!monitor) return { ok: false, reason: 'no_monitor_source' };

      let processHandle;
      try {
        processHandle = spawnImpl('parec', [
          `--device=${monitor}`,
          `--rate=${SAMPLE_RATE}`,
          '--format=s16le',
          '--channels=2',
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        return { ok: false, reason: error && error.code === 'ENOENT' ? 'tool_missing' : 'spawn_failed' };
      }
      // Defer the ready state until the child actually spawns. A missing parec
      // surfaces as an asynchronous spawn error, not a throw, so waiting on
      // spawn/error keeps start() from claiming ready for a process that never
      // existed.
      const setup = await new Promise((resolve) => {
        let settled = false;
        const done = (ok, reason = null) => { if (settled) return; settled = true; resolve({ ok, reason }); };
        processHandle.once('spawn', () => done(true));
        processHandle.once('error', (error) => {
          done(false, error && error.code === 'ENOENT' ? 'tool_missing' : 'spawn_failed');
        });
      });
      if (myGeneration !== generation) {
        try { processHandle.kill('SIGTERM'); } catch {}
        return { ok: false, reason: 'superseded' };
      }
      if (!setup.ok) {
        onState({ state: 'failed', reason: setup.reason });
        return setup;
      }
      child = processHandle;
      const buffer = { value: Buffer.alloc(0) };
      let stderrBytes = 0;
      processHandle.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 65536) {
          try { processHandle.kill('SIGTERM'); } catch {}
        }
      });
      processHandle.stdout.on('data', (chunk) => {
        if (myGeneration !== generation || intentionalStop || !ready) return;
        buffer.value = Buffer.concat([buffer.value, Buffer.from(chunk)]);
        while (buffer.value.length >= STEREO_BYTES_PER_CHUNK) {
          const frame = buffer.value.subarray(0, STEREO_BYTES_PER_CHUNK);
          buffer.value = buffer.value.subarray(STEREO_BYTES_PER_CHUNK);
          onPcm(downmixStereoPcm(frame));
        }
      });
      processHandle.on('error', () => {
        // Ignore errors from superseded children (a newer start owns the slot).
        if (myGeneration !== generation && child !== processHandle) return;
        ready = false;
        if (child === processHandle) child = null;
        onState({ state: 'failed', reason: 'spawn_failed' });
        onUnexpectedExit({ code: null });
      });
      processHandle.on('close', (code) => {
        // A child killed by stop() has a stale generation but is still the
        // active child; report its intentional exit. Only genuinely stale
        // children from a superseded start are ignored.
        if (myGeneration !== generation && child !== processHandle) return;
        const wasIntentional = intentionalStop;
        ready = false;
        if (child === processHandle) child = null;
        if (wasIntentional) {
          onState({ state: 'stopped' });
          return;
        }
        onState({ state: 'failed', reason: code === 0 ? 'stream_stopped' : 'stream_failed' });
        onUnexpectedExit({ code });
      });
      ready = true;
      onState({ state: 'ready' });
      return { ok: true };
    })().finally(() => { startPromise = null; });
    return startPromise;
  }

  async function stop({ immediate = false } = {}) {
    // Invalidate any discovery still in flight so a late parec spawn after
    // shutdown starts is killed by the generation check instead of running.
    generation += 1;
    intentionalStop = true;
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    } else if (immediate) {
      ready = false;
      onState({ state: 'stopped' });
    }
    return { ok: true };
  }

  return { start, stop, availability };
}

module.exports = {
  createLinuxMonitorCapture,
  parseDefaultSink,
  findMonitorSource,
  downmixStereoPcm,
  CHUNK_MS,
  SAMPLE_RATE,
  MONO_BYTES_PER_CHUNK,
  STEREO_BYTES_PER_CHUNK,
};
