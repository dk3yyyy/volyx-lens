'use strict';

// Phase 5 scaffolding (Windows runtime parity): shared path utilities used by
// dev/whisper-binary.js. Kept out of src/ with the downloader until it is
// wired into the packaged app.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Shared path utilities for Volyx Lens
// Works in both main and renderer processes

let userDataPath = null;

function setUserDataPath(p) {
  userDataPath = p;
}

function getUserDataPath() {
  if (userDataPath) return userDataPath;
  // Try Electron's app.getPath('userData') if available (main process)
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch {}
  // Fallback for renderer or non-Electron contexts
  return path.join(os.homedir(), '.volyx-lens');
}

function getModelsDir() {
  return path.join(getUserDataPath(), 'whisper-models');
}

function getBinariesDir(version = 'v1.9.2') {
  return path.join(getUserDataPath(), 'whisper-binaries', version);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  setUserDataPath,
  getUserDataPath,
  getModelsDir,
  getBinariesDir,
  ensureDir,
};