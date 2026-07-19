const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_CHARACTERS = 20000;
const DEFAULT_TIMEOUT_MS = 120000;
const activeChildren = new Map();
const pendingJobs = new Set();
let cancellationGeneration = 0;
let offlineQueue = Promise.resolve();

function offlineError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateOfflineConfig(env = process.env) {
  const executable = String(env.VOLYX_LENS_WHISPER_CLI || '').trim();
  const model = String(env.VOLYX_LENS_WHISPER_MODEL || '').trim();
  if (!executable || !model) return { ready: false, error: 'Set VOLYX_LENS_WHISPER_CLI and VOLYX_LENS_WHISPER_MODEL before launching Volyx Lens.' };
  if (!path.isAbsolute(executable) || !path.isAbsolute(model)) return { ready: false, error: 'Offline transcription paths must be absolute.' };
  try {
    const resolvedExecutable = fs.realpathSync(executable);
    const resolvedModel = fs.realpathSync(model);
    fs.accessSync(resolvedExecutable, fs.constants.X_OK);
    const executableStat = fs.statSync(resolvedExecutable);
    const modelStat = fs.statSync(resolvedModel);
    if (!executableStat.isFile()) throw new Error('adapter is not a regular file');
    if (!modelStat.isFile()) throw new Error('model is not a regular file');
    if ((executableStat.mode & 0o002) || (modelStat.mode & 0o002)) throw new Error('adapter and model must not be world-writable');
    return { ready: true, executable: resolvedExecutable, model: resolvedModel };
  } catch (error) {
    return { ready: false, error: `Offline transcription is unavailable: ${error.message}` };
  }
}

async function runWhisperCli({ executable, model, wav, language = '', timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn, jobState = { cancelled: false } }) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'volyx-lens-offline-stt-'));
  const input = path.join(directory, 'audio.wav');
  const outputPrefix = path.join(directory, 'transcript');
  const output = `${outputPrefix}.txt`;
  try {
    await fs.promises.chmod(directory, 0o700);
    await fs.promises.writeFile(input, wav, { mode: 0o600, flag: 'wx' });
    if (jobState.cancelled) throw offlineError('Offline transcription was cancelled.', 'offline_cancelled');
    const args = ['-m', model, '-f', input, '--output-txt', '--output-file', outputPrefix, '--no-timestamps'];
    if (language) args.push('-l', language);
    return await new Promise((resolve, reject) => {
      const child = spawnImpl(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '' },
      });
      const childState = jobState;
      childState.timedOut = false;
      activeChildren.set(child, childState);
      let stderrBytes = 0;
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeChildren.delete(child);
        callback(value);
      };
      child.stderr.on('data', (chunk) => { stderrBytes = Math.min(65536, stderrBytes + chunk.length); });
      timer = setTimeout(() => {
        childState.timedOut = true;
        child.kill('SIGKILL');
      }, Math.max(1000, Math.min(300000, timeoutMs)));
      child.once('error', (error) => finish(reject, offlineError(error.message, 'offline_spawn_failed')));
      child.once('close', async (code) => {
        if (settled) return;
        if (childState.cancelled) return finish(reject, offlineError('Offline transcription was cancelled.', 'offline_cancelled'));
        if (childState.timedOut) return finish(reject, offlineError('Offline transcription timed out.', 'offline_timeout'));
        if (code !== 0) return finish(reject, offlineError(`Offline transcription failed with exit code ${code}${stderrBytes ? ' (adapter reported an error)' : ''}.`, 'offline_exit'));
        try {
          const stat = await fs.promises.stat(output);
          if (stat.size > MAX_TRANSCRIPT_BYTES) throw offlineError('Offline transcript exceeded the 64 KiB safety limit.', 'offline_output_oversized');
          const text = (await fs.promises.readFile(output, 'utf8')).trim();
          if (text.includes('\0') || text.length > MAX_TRANSCRIPT_CHARACTERS) throw offlineError('Offline transcript output was invalid or oversized.', 'offline_output_invalid');
          finish(resolve, text);
        } catch (error) { finish(reject, error); }
      });
    });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

async function transcribeOffline(wav, { env = process.env, language = '', timeoutMs, spawnImpl } = {}) {
  const config = validateOfflineConfig(env);
  if (!config.ready) throw offlineError(config.error, 'offline_not_configured');
  const generation = cancellationGeneration;
  const jobState = { cancelled: false, timedOut: false };
  pendingJobs.add(jobState);
  const job = offlineQueue.catch(() => {}).then(() => {
    if (jobState.cancelled || generation !== cancellationGeneration) throw offlineError('Offline transcription was cancelled.', 'offline_cancelled');
    return runWhisperCli({ ...config, wav, language, timeoutMs, spawnImpl, jobState });
  }).finally(() => pendingJobs.delete(jobState));
  offlineQueue = job.catch(() => {});
  return job;
}

function cancelOfflineTranscriptions() {
  cancellationGeneration += 1;
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

module.exports = {
  validateOfflineConfig,
  runWhisperCli,
  transcribeOffline,
  cancelOfflineTranscriptions,
  DEFAULT_TIMEOUT_MS,
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_CHARACTERS,
};
