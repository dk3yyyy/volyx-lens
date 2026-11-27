'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_SPEECH_MODELS_DIR = path.join(os.homedir(), '.volyx-lens', 'speech-models');

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
    await fsImpl.promises.rm(paths.partialPath, { force: true });
    await fsImpl.promises.rm(paths.receiptPartialPath, { force: true });

    const hash = crypto.createHash('sha256');
    let received = 0;
    let handle = null;
    try {
      const response = await fetchImpl(sourceUrl(model), {
        redirect: 'follow',
        ...(signal ? { signal } : {}),
      });
      if (!response || !response.ok || !response.body) {
        throw new Error(`Model download failed${response ? ` with HTTP ${response.status}` : ''}.`);
      }

      handle = await fsImpl.promises.open(paths.partialPath, 'wx', 0o600);
      for await (const chunk of response.body) {
        throwIfAborted(signal);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > artifact.bytes) throw new Error('Model download exceeded its pinned size.');
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.write(bytes, offset, bytes.length - offset);
          if (result.bytesWritten <= 0) throw new Error('Model download could not be written to disk.');
          offset += result.bytesWritten;
        }
        onProgress(Math.min(received / artifact.bytes, 1));
      }
      await handle.sync();
      await handle.close();
      handle = null;
      throwIfAborted(signal);

      if (received !== artifact.bytes) throw new Error(`Model download size mismatch: received ${received}, expected ${artifact.bytes}.`);
      const digest = hash.digest('hex');
      if (digest !== artifact.sha256) throw new Error('Model download did not match its pinned SHA-256.');

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
      for (const file of [paths.partialPath, paths.receiptPartialPath, paths.modelPath, paths.receiptPath]) {
        try { await fsImpl.promises.rm(file, { force: true }); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
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
