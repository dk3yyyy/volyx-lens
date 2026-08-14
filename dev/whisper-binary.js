'use strict';

// Phase 5 scaffolding (Windows runtime parity): cross-platform whisper.cpp
// server download/provisioning. Not yet wired into src/stt.js or the packaged
// app. Kept out of src/ so it is not swept into the asar (build.files is
// scoped to src/**). Will be integrated when the sidecar gains automatic
// binary provisioning on macOS, Windows, and Linux.

const fs = require('fs');
const path = require('path');
const os = require('node:os');
const crypto = require('crypto');
const fetch = require('node-fetch').default;
const { ensureDir, getBinariesDir } = require('./paths');

// whisper.cpp server binary download and verification
// Downloads from ggerganov/whisper.cpp releases, verifies SHA-256, makes executable

const BINARY_BASE_URL = process.env.WHISPER_BINARY_BASE || 'https://github.com/ggerganov/whisper.cpp/releases/download';

// whisper.cpp version to use - pin to a known good release
const WHISPER_CPP_VERSION = 'v1.7.4';

// Platform/arch mapping to whisper.cpp release assets
const BINARY_MAP = {
  'darwin-arm64': { asset: 'whisper-macos-arm64.tar.gz', binary: 'whisper-server' },
  'darwin-x64': { asset: 'whisper-macos-x86_64.tar.gz', binary: 'whisper-server' },
  'linux-arm64': { asset: 'whisper-linux-arm64.tar.gz', binary: 'whisper-server' },
  'linux-x64': { asset: 'whisper-linux-x86_64.tar.gz', binary: 'whisper-server' },
  'win32-x64': { asset: 'whisper-win64-x86_64.zip', binary: 'whisper-server.exe' },
};

function getPlatformKey() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'win32') return 'win32-x64';
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

function getBinaryDir() {
  return getBinariesDir(WHISPER_CPP_VERSION);
}

function getBinaryPath() {
  const key = getPlatformKey();
  const info = BINARY_MAP[key];
  if (!info) throw new Error(`No whisper.cpp binary for ${key}`);
  return path.join(getBinaryDir(), info.binary);
}

function getExpectedSha256() {
  // In a real implementation, these would be verified against the release page
  // For now, we skip SHA-256 for the binary (models have SHA-256)
  // TODO: add binary SHA-256 from release assets
  return null;
}

async function downloadWithProgress(url, dest, onProgress) {
  ensureDir(path.dirname(dest));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') || '0');
  let downloaded = 0;
  const chunks = [];
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    downloaded += buf.length;
    if (onProgress && total) onProgress(downloaded / total);
  }
  const data = Buffer.concat(chunks);
  await fs.promises.writeFile(dest, data);
  return data;
}

async function extractTarGz(tarGzPath, destDir) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', tarGzPath, '-C', destDir], { stdio: 'ignore' });
    tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar failed with code ${code}`)));
    tar.on('error', reject);
  });
}

async function extractZip(zipPath, destDir) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const unzip = spawn('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'ignore' });
    unzip.on('close', (code) => code === 0 ? resolve() : reject(new Error(`unzip failed with code ${code}`)));
    unzip.on('error', reject);
  });
}

async function ensureBinary(onProgress) {
  const key = getPlatformKey();
  const info = BINARY_MAP[key];
  const binaryPath = getBinaryPath();

  if (fs.existsSync(binaryPath)) {
    try { fs.accessSync(binaryPath, fs.constants.X_OK); return binaryPath; } catch {}
  }

  ensureDir(getBinaryDir());

  const url = `${BINARY_BASE_URL}/${WHISPER_CPP_VERSION}/${info.asset}`;
  const tempAsset = path.join(getBinaryDir(), `download-${info.asset}`);

  await downloadWithProgress(url, tempAsset, onProgress);

  if (info.asset.endsWith('.tar.gz')) {
    await extractTarGz(tempAsset, getBinaryDir());
  } else if (info.asset.endsWith('.zip')) {
    await extractZip(tempAsset, getBinaryDir());
  } else {
    throw new Error(`Unknown archive format: ${info.asset}`);
  }

  try { fs.unlinkSync(tempAsset); } catch {}

  if (fs.existsSync(binaryPath)) {
    fs.chmodSync(binaryPath, 0o755);
    return binaryPath;
  }

  const found = findBinary(getBinaryDir(), info.binary);
  if (found) {
    fs.chmodSync(found, 0o755);
    if (found !== binaryPath) {
      ensureDir(path.dirname(binaryPath));
      fs.renameSync(found, binaryPath);
    }
    return binaryPath;
  }

  throw new Error(`Binary ${info.binary} not found after extraction`);
}

function findBinary(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findBinary(full, name);
      if (found) return found;
    } else if (entry.name === name || entry.name === `./${name}`) {
      return full;
    }
  }
  return null;
}

module.exports = {
  WHISPER_CPP_VERSION,
  BINARY_MAP,
  getPlatformKey,
  getBinaryDir,
  getBinaryPath,
  getExpectedSha256,
  ensureBinary,
  downloadWithProgress,
};