'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_SPEECH_MODELS_DIR = path.join(os.homedir(), '.volyx-lens', 'speech-models');
// Throughput is averaged over a window instead of per-chunk deltas: hotel Wi-Fi
// delivers bursty chunks and instantaneous rates make the UI unusable.
const THROUGHPUT_WINDOW_MS = 2500;

function createThroughputMeter() {
  let samples = [{ at: process.hrtime.bigint(), bytes: 0 }];
  return {
    reset(bytes = 0) {
      samples = [{ at: process.hrtime.bigint(), bytes }];
    },
    sample(bytes) {
      const at = process.hrtime.bigint();
      samples.push({ at, bytes });
      const cutoff = at - BigInt(THROUGHPUT_WINDOW_MS) * 1000000n;
      while (samples.length > 2 && samples[1].at <= cutoff) samples.shift();
      const baseline = samples[0];
      const transferred = bytes - baseline.bytes;
      if (transferred <= 0) return 0;
      const elapsedMs = Number(at - baseline.at) / 1e6;
      return Math.round((transferred * 1000) / Math.max(elapsedMs, 1));
    },
  };
}

function validateArtifactModel(model) {
  const artifact = model && model.artifact;
  if (!model || !MODEL_ID_PATTERN.test(String(model.id || ''))
      || !REVISION_PATTERN.test(String(artifact && artifact.revision || ''))
      || !SHA256_PATTERN.test(String(artifact && artifact.sha256 || ''))
      || !Number.isSafeInteger(artifact && artifact.bytes) || artifact.bytes <= 0
      || typeof (artifact && artifact.filename) !== 'string'
      || path.basename(artifact.filename) !== artifact.filename
      || typeof (artifact && artifact.repository) !== 'string'
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(artifact.repository)) {
    throw new TypeError('Invalid pinned speech-model artifact definition.');
  }
  return artifact;
}

function sha256File(filePath, fsImpl = fs) {
  const hash = crypto.createHash('sha256');
  const fd = fsImpl.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fsImpl.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fsImpl.closeSync(fd);
  }
  return hash.digest('hex');
}

function createSpeechModelArtifactStore({
  root = DEFAULT_SPEECH_MODELS_DIR,
  fetchImpl = globalThis.fetch,
  fsImpl = fs,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const activeDownloads = new Set();

  function pathsFor(model) {
    const artifact = validateArtifactModel(model);
    const modelDirectory = path.join(root, model.id);
    const directory = path.join(root, model.id, artifact.revision);
    const modelPath = path.join(directory, artifact.filename);
    return {
      modelDirectory,
      directory,
      modelPath,
      partialPath: `${modelPath}.part`,
      receiptPath: `${modelPath}.verified.json`,
      receiptPartialPath: `${modelPath}.verified.json.part`,
    };
  }

  function sourceUrl(model) {
    const artifact = validateArtifactModel(model);
    return `https://huggingface.co/${artifact.repository}/resolve/${artifact.revision}/${encodeURIComponent(artifact.filename)}`;
  }

  function isInstalled(model) {
    const artifact = validateArtifactModel(model);
    const paths = pathsFor(model);
    try {
      const stat = fsImpl.statSync(paths.modelPath);
      const receipt = JSON.parse(fsImpl.readFileSync(paths.receiptPath, 'utf8'));
      return stat.isFile()
        && stat.size === artifact.bytes
        && receipt.modelId === model.id
        && receipt.revision === artifact.revision
        && receipt.bytes === artifact.bytes
        && receipt.sha256 === artifact.sha256;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }

  async function verifyModel(model) {
    const artifact = validateArtifactModel(model);
    const paths = pathsFor(model);
    if (!isInstalled(model)) return false;
    const hash = crypto.createHash('sha256');
    for await (const chunk of fsImpl.createReadStream(paths.modelPath)) hash.update(chunk);
    return hash.digest('hex') === artifact.sha256;
  }

  function throwIfAborted(signal) {
    if (!signal || !signal.aborted) return;
    const error = new Error('Speech model download was cancelled.');
    error.name = 'AbortError';
    throw error;
  }

  async function partialSize(partialPath) {
    try {
      const stat = await fsImpl.promises.stat(partialPath);
      if (!stat.isFile()) return 0;
      return Number.isSafeInteger(stat.size) && stat.size > 0 ? stat.size : 0;
    } catch (error) {
      if (error && error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async function hashPrefix(partialPath, length) {
    const hash = crypto.createHash('sha256');
    if (length <= 0) return hash;
    for await (const chunk of fsImpl.createReadStream(partialPath, { start: 0, end: length - 1 })) {
      hash.update(chunk);
    }
    return hash;
  }

  function requestArtifact(url, offset, signal) {
    return fetchImpl(url, {
      redirect: 'follow',
      // A resumed download asks only for the missing tail. A server that does
      // not honour ranges answers 200 with the whole body, which we handle by
      // truncating the partial instead of appending duplicates.
      ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  async function downloadModel(model, onProgress, { signal } = {}) {
    const artifact = validateArtifactModel(model);
    const paths = pathsFor(model);
    throwIfAborted(signal);

    await fsImpl.promises.mkdir(paths.directory, { recursive: true, mode: 0o700 });
    await fsImpl.promises.chmod(paths.directory, 0o700);

    if (isInstalled(model) && await verifyModel(model)) {
      return { path: paths.modelPath, modelId: model.id, revision: artifact.revision, sha256: artifact.sha256 };
    }

    await fsImpl.promises.rm(paths.modelPath, { force: true });
    await fsImpl.promises.rm(paths.receiptPath, { force: true });
    await fsImpl.promises.rm(paths.receiptPartialPath, { force: true });

    // Keep a partial only while it is a usable prefix of the pinned artifact.
    let offset = await partialSize(paths.partialPath);
    if (offset >= artifact.bytes) {
      await fsImpl.promises.rm(paths.partialPath, { force: true });
      offset = 0;
    }

    let hash = await hashPrefix(paths.partialPath, offset);
    let received = offset;
    let resumedFrom = offset;
    let handle = null;
    let definitiveFailure = false;
    const throughput = createThroughputMeter();
    throughput.reset(offset);

    const restartFromZero = async () => {
      offset = 0;
      resumedFrom = 0;
      received = 0;
      hash = crypto.createHash('sha256');
      throughput.reset(0);
      await fsImpl.promises.rm(paths.partialPath, { force: true });
    };

    try {
      let response = await requestArtifact(sourceUrl(model), offset, signal);
      if (response && response.status === 416) {
        // The server cannot satisfy the requested range: the prefix is not
        // usable for a byte-range request. Start over once.
        await restartFromZero();
        response = await requestArtifact(sourceUrl(model), 0, signal);
      }
      if (!response || !response.ok || !response.body) {
        throw new Error(`Model download failed${response ? ` with HTTP ${response.status}` : ''}.`);
      }
      if (offset > 0) {
        let restart = response.status !== 206;
        let refetch = false;
        if (!restart) {
          const contentRange = typeof response.headers?.get === 'function'
            ? response.headers.get('content-range') : null;
          const start = /^bytes\s+(\d+)-/i.exec(String(contentRange || ''));
          // A 206 that starts somewhere else is a tail of the artifact, not our
          // remainder; it must be discarded and the full body requested again.
          if (start && Number(start[1]) !== offset) {
            restart = true;
            refetch = true;
          }
        }
        if (restart) {
          await restartFromZero();
          // A 200 body is already the whole artifact, so it can be written from
          // zero. Only a misleading 206 needs a new request.
          if (refetch) {
            response = await requestArtifact(sourceUrl(model), 0, signal);
            if (!response || !response.ok || !response.body) {
              throw new Error(`Model download failed${response ? ` with HTTP ${response.status}` : ''}.`);
            }
          }
        }
      }

      handle = await fsImpl.promises.open(paths.partialPath, offset > 0 ? 'a' : 'w', 0o600);
      await fsImpl.promises.chmod(paths.partialPath, 0o600);
      for await (const chunk of response.body) {
        throwIfAborted(signal);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > artifact.bytes) {
          definitiveFailure = true;
          throw new Error('Model download exceeded its pinned size.');
        }
        hash.update(bytes);
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written);
          if (result.bytesWritten <= 0) throw new Error('Model download could not be written to disk.');
          written += result.bytesWritten;
        }
        onProgress(Math.min(received / artifact.bytes, 1), {
          receivedBytes: received,
          totalBytes: artifact.bytes,
          bytesPerSecond: throughput.sample(received),
          resumedFrom,
        });
      }
      await handle.sync();
      await handle.close();
      handle = null;
      throwIfAborted(signal);

      if (received !== artifact.bytes) {
        // Short read: the connection ended early. The bytes already on disk are
        // valid prefix material, so leave the .part for the next attempt.
        throw new Error(`Model download size mismatch: received ${received}, expected ${artifact.bytes}.`);
      }
      const digest = hash.digest('hex');
      if (digest !== artifact.sha256) {
        // A complete body with the wrong digest cannot be resumed into a valid
        // artifact; keeping it would poison every future attempt.
        definitiveFailure = true;
        throw new Error('Model download did not match its pinned SHA-256.');
      }

      await fsImpl.promises.rename(paths.partialPath, paths.modelPath);
      throwIfAborted(signal);
      await fsImpl.promises.chmod(paths.modelPath, 0o600);
      const stat = await fsImpl.promises.stat(paths.modelPath);
      const receipt = {
        modelId: model.id,
        revision: artifact.revision,
        bytes: artifact.bytes,
        sha256: digest,
        modifiedAt: stat.mtimeMs,
        verifiedAt: now(),
      };
      await fsImpl.promises.writeFile(paths.receiptPartialPath, JSON.stringify(receipt), { mode: 0o600 });
      throwIfAborted(signal);
      await fsImpl.promises.rename(paths.receiptPartialPath, paths.receiptPath);
      return { path: paths.modelPath, modelId: model.id, revision: artifact.revision, sha256: digest };
    } catch (error) {
      const cleanupErrors = [];
      if (handle) {
        try { await handle.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      const files = [paths.receiptPartialPath, paths.modelPath, paths.receiptPath];
      if (definitiveFailure) files.push(paths.partialPath);
      for (const file of files) {
        try { await fsImpl.promises.rm(file, { force: true }); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (!definitiveFailure) {
        // Transient failures and cancellation keep a resumable partial, and it
        // keeps the same private mode as a completed artifact.
        try { await fsImpl.promises.chmod(paths.partialPath, 0o600); } catch (cleanupError) {
          if (!cleanupError || cleanupError.code !== 'ENOENT') cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length) {
        const cleanupError = new AggregateError(cleanupErrors, 'Speech model download cleanup failed.');
        if (error instanceof Error) error.cleanupError = cleanupError;
        else throw new AggregateError([new Error(String(error)), cleanupError], 'Speech model download and cleanup failed.');
      }
      throw error;
    }
  }

  async function prepareModel(model, onProgress = () => {}, options = {}) {
    if (typeof onProgress !== 'function') throw new TypeError('A model download progress callback must be a function.');
    const artifact = validateArtifactModel(model);
    const key = `${model.id}:${artifact.revision}`;
    if (activeDownloads.has(key)) {
      const error = new Error(`Speech model is already downloading: ${model.id}`);
      error.code = 'speech_model_download_in_progress';
      throw error;
    }
    activeDownloads.add(key);
    try {
      return await downloadModel(model, onProgress, options);
    } finally {
      activeDownloads.delete(key);
    }
  }

  async function removeModel(model) {
    validateArtifactModel(model);
    const paths = pathsFor(model);
    await fsImpl.promises.rm(paths.modelDirectory, { recursive: true, force: true });
    return true;
  }

  function paths(model) {
    return { ...pathsFor(model) };
  }

  return { paths, sourceUrl, isInstalled, verifyModel, prepareModel, removeModel };
}

module.exports = {
  createSpeechModelArtifactStore,
  validateArtifactModel,
  DEFAULT_SPEECH_MODELS_DIR,
  MODEL_ID_PATTERN,
  REVISION_PATTERN,
  SHA256_PATTERN,
};
