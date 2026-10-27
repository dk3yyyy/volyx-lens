'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { downloadModel } = require('../src/whisper-sidecar');
const { FILES, fileFor, unavailableReason } = require('../src/whisper-models');

function temporaryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'volyx-whisper-'));
}

// A fake response whose body yields the given chunks, like a streaming HTTP body.
function responseFor(chunks, { ok = true, contentLength } = {}) {
  return {
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? 'OK' : 'Not Found',
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(contentLength ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0)) : null) },
    body: (async function* stream() { for (const chunk of chunks) yield chunk; })(),
  };
}

// The manifest pins the real model digests, which we cannot reproduce here, so the
// tamper cases assert against a manifest-shaped fixture instead.
function pinnedFixture(bytes) {
  return {
    file: 'ggml-fixture.bin',
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

test('every advertised model has a published file and a digest', () => {
  const { MODEL_SPECS } = require('../src/whisper-sidecar');
  for (const id of Object.keys(MODEL_SPECS)) {
    const entry = fileFor(id);
    if (!entry) {
      assert.ok(unavailableReason(id), `${id} must explain why it cannot be downloaded`);
      continue;
    }
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${id} carries a SHA-256`);
    assert.ok(entry.bytes > 0, `${id} carries a size`);
    assert.match(entry.file, /^ggml-.+\.bin$/, `${id} names the upstream file`);
  }
});

test('the manifest no longer points at a path that does not exist upstream', () => {
  // The old URL was /models/whisper.cpp/<id>.bin, which 404s: upstream files are
  // ggml-<name>.bin at the repository root.
  for (const [id, entry] of Object.entries(FILES)) {
    assert.doesNotMatch(entry.file, /\//, `${id} is a root file`);
  }
});

test('a model with no published file is refused instead of guessed at', async () => {
  await assert.rejects(
    downloadModel('distil-large-v3', null, { dir: temporaryDir(), fetchImpl: async () => { throw new Error('should not fetch'); } }),
    /cannot be downloaded/,
  );
});

test('a download whose bytes do not match the pinned digest is rejected and removed', async () => {
  const dir = temporaryDir();
  const good = Buffer.from('the real model bytes');
  const pinned = { file: 'ggml-fixture.bin', bytes: good.length, sha256: crypto.createHash('sha256').update(Buffer.from('something else')).digest('hex') };
  await assert.rejects(
    downloadModel('tiny', null, { dir, manifest: pinned, fetchImpl: async () => responseFor([good]) }),
    /did not match its published SHA-256/,
  );
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing is left in place, not even the partial file');
});

test('a body larger than the manifest size is cut off instead of filling the disk', async () => {
  const dir = temporaryDir();
  const pinned = { file: 'ggml-fixture.bin', bytes: 16, sha256: 'a'.repeat(64) };
  await assert.rejects(
    downloadModel('tiny', null, { dir, manifest: pinned, fetchImpl: async () => responseFor([Buffer.alloc(12, 7), Buffer.alloc(12, 7)]) }),
    /exceeded its expected size/,
  );
  assert.deepEqual(fs.readdirSync(dir), [], 'and the oversized file is gone');
});

test('a matching download lands with private permissions and a digest index', async () => {
  const dir = temporaryDir();
  const good = Buffer.from('a small stand-in for a whisper model');
  const pinned = { file: 'ggml-fixture.bin', bytes: good.length, sha256: crypto.createHash('sha256').update(good).digest('hex') };
  const progress = [];
  const result = await downloadModel('tiny', (fraction) => progress.push(fraction), {
    dir,
    manifest: pinned,
    fetchImpl: async () => responseFor([good.subarray(0, 10), good.subarray(10)]),
  });
  assert.equal(result.sha256, pinned.sha256);
  assert.equal(fs.readFileSync(path.join(dir, 'tiny.bin')).toString(), good.toString());
  assert.equal(fs.statSync(path.join(dir, 'tiny.bin')).mode & 0o777, 0o600, 'the model is private to the user');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'tiny.idx'), 'utf8'));
  assert.equal(index.sha256, pinned.sha256);
  assert.equal(progress[progress.length - 1], 1, 'progress finishes at one');

  // A second call with the file in place verifies it and does not download again.
  let fetched = 0;
  const again = await downloadModel('tiny', null, {
    dir,
    manifest: pinned,
    fetchImpl: async () => { fetched += 1; return responseFor([good]); },
  });
  assert.equal(fetched, 0, 'the pinned digest already matches on disk');
  assert.equal(again.path, path.join(dir, 'tiny.bin'));
});

test('the model directory is private to the user', () => {
  const dir = temporaryDir();
  const nested = path.join(dir, 'whisper-models');
  const { ensureDir } = require('../src/whisper-sidecar');
  ensureDir(nested);
  assert.equal(fs.statSync(nested).mode & 0o777, 0o700);
  fs.chmodSync(nested, 0o755);
  ensureDir(nested);
  assert.equal(fs.statSync(nested).mode & 0o777, 0o700, 'an existing directory is tightened too');
});

test('the SHA-256 helper streams instead of reading the whole file', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'whisper-sidecar.js'), 'utf8');
  assert.match(source, /fs\.readSync\(fd, buffer, 0, buffer\.length, null\)/);
  assert.doesNotMatch(source, /readFileSync\(filePath\)/, 'the 3 GB model must not be buffered');
});
