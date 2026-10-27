'use strict';

// What a whisper model download is allowed to be.
//
// The previous code downloaded to a guessed path, buffered the whole file in memory
// and then hashed whatever had arrived to decide it was fine, so the "verification"
// only proved the bytes were stable, not that they were the model (VR-23). These
// digests come from the published file metadata of ggerganov/whisper.cpp: each is the
// LFS object id of the file at that path, which is its SHA-256.

const WHISPER_REPO_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

const FILES = Object.freeze({
  tiny: { file: 'ggml-tiny.bin', bytes: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' },
  'tiny.en': { file: 'ggml-tiny.en.bin', bytes: 77704715, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f' },
  'tiny.int8': { file: 'ggml-tiny-q8_0.bin', bytes: 43537433, sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca' },
  base: { file: 'ggml-base.bin', bytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
  'base.en': { file: 'ggml-base.en.bin', bytes: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
  'base.int8': { file: 'ggml-base-q8_0.bin', bytes: 81768585, sha256: 'c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9' },
  small: { file: 'ggml-small.bin', bytes: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
  'small.en': { file: 'ggml-small.en.bin', bytes: 487614201, sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d' },
  'small.int8': { file: 'ggml-small-q8_0.bin', bytes: 264464607, sha256: '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f' },
  medium: { file: 'ggml-medium.bin', bytes: 1533763059, sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208' },
  'medium.en': { file: 'ggml-medium.en.bin', bytes: 1533774781, sha256: 'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356' },
  'medium.int8': { file: 'ggml-medium-q8_0.bin', bytes: 823369779, sha256: '42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502' },
  'large-v3': { file: 'ggml-large-v3.bin', bytes: 3095033483, sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2' },
  // Upstream publishes only a q5_0 quantisation for large-v3, so the "int8" tier
  // points at that file rather than inventing a name that 404s.
  'large-v3.int8': { file: 'ggml-large-v3-q5_0.bin', bytes: 1081140203, sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1' },
  large: { file: 'ggml-large-v2.bin', bytes: 3094623691, sha256: '9a423fe4d40c82774b6af34115b8b935f34152246eb19e80e376071d3f999487' },
  'large.int8': { file: 'ggml-large-v2-q8_0.bin', bytes: 1656129691, sha256: 'fef54e6d898246a65c8285bfa83bd1807e27fadf54d5d4e81754c47634737e8c' },
});

// Ids the UI can offer but that have no published file. They are reported as
// unavailable instead of being downloaded from a guessed URL.
const UNAVAILABLE = Object.freeze({
  'large-v3.en': 'whisper.cpp publishes no English-only large-v3 model.',
  'distil-large-v3': 'Distil-Whisper is not published in the whisper.cpp model repository.',
});

function fileFor(modelId) {
  return FILES[String(modelId || '').toLowerCase()] || null;
}

function unavailableReason(modelId) {
  return UNAVAILABLE[String(modelId || '').toLowerCase()] || '';
}

function downloadUrl(modelId, base = process.env.WHISPER_DOWNLOAD_BASE || WHISPER_REPO_BASE) {
  const entry = fileFor(modelId);
  if (!entry) return null;
  return `${String(base).replace(/\/+$/, '')}/${entry.file}`;
}

module.exports = { FILES, UNAVAILABLE, WHISPER_REPO_BASE, fileFor, unavailableReason, downloadUrl };
