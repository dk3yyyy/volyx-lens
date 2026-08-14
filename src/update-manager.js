'use strict';

const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32', 'linux']);

function platformName(platform) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function unsupportedMessage(platform) {
  if (platform === 'darwin') return 'Updates are available in official signed macOS release builds.';
  return `Updates are available in official ${platformName(platform)} release builds.`;
}

function releaseChannel(platform, arch) {
  // macOS uses per-arch channels (latest-arm64 / latest-x64); Windows and Linux
  // both publish to their platform default (latest / latest-linux).
  if (platform === 'darwin') return `latest-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  return 'latest';
}

function createUpdateManager({ app, platform = process.platform, arch = process.arch, releaseBuild = false, updaterFactory, emit = () => {} }) {
  const supported = Boolean(app && app.isPackaged && SUPPORTED_PLATFORMS.has(platform) && releaseBuild === true);
  let state = supported
    ? publicState('idle', 'Check GitHub Releases for a signed Volyx Lens update.')
    : publicState('unsupported', unsupportedMessage(platform));
  let updater = null;
  let activeCheck = null;
  let activeDownload = null;

  function publicState(status, message, extra = {}) {
    return {
      supported,
      currentVersion: String(app && app.getVersion ? app.getVersion() : '0.0.0'),
      status,
      message,
      availableVersion: extra.availableVersion || null,
      progress: Number.isFinite(extra.progress) ? Math.max(0, Math.min(100, Math.round(extra.progress))) : null,
    };
  }

  function setState(status, message, extra = {}) {
    state = publicState(status, message, {
      availableVersion: Object.prototype.hasOwnProperty.call(extra, 'availableVersion') ? extra.availableVersion : state.availableVersion,
      progress: extra.progress,
    });
    emit({ ...state });
    return { ...state };
  }

  function safeVersion(info) {
    const value = String(info && info.version || '').trim();
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) ? value.slice(0, 64) : null;
  }

  function ensureSupported() {
    if (!supported) throw new Error(unsupportedMessage(platform));
  }

  function initialize() {
    if (!supported || updater) return updater;
    updater = updaterFactory();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.channel = releaseChannel(platform, arch);
    // electron-updater enables downgrades when its channel setter is used.
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => setState('checking', 'Checking for updates…', { availableVersion: null }));
    updater.on('update-available', (info) => {
      const version = safeVersion(info);
      setState('available', version ? `Volyx Lens ${version} is available.` : 'A new Volyx Lens update is available.', { availableVersion: version });
    });
    updater.on('update-not-available', () => setState('current', 'Volyx Lens is up to date.', { availableVersion: null }));
    updater.on('download-progress', (progress) => {
      const percent = Number(progress && progress.percent);
      setState('downloading', Number.isFinite(percent) ? `Downloading update… ${Math.round(percent)}%` : 'Downloading update…', { progress: percent });
    });
    updater.on('update-downloaded', (info) => {
      const version = safeVersion(info) || state.availableVersion;
      setState('downloaded', version ? `Volyx Lens ${version} is ready to install.` : 'The update is ready to install.', { availableVersion: version, progress: 100 });
    });
    updater.on('error', () => setState('error', 'The update service is unavailable. Try again later.', { availableVersion: null }));
    return updater;
  }

  async function check() {
    ensureSupported();
    if (activeCheck) {
      await activeCheck;
      return { ...state };
    }
    const service = initialize();
    setState('checking', 'Checking for updates…', { availableVersion: null });
    activeCheck = Promise.resolve(service.checkForUpdates())
      .catch(() => setState('error', 'The update service is unavailable. Try again later.', { availableVersion: null }))
      .finally(() => { activeCheck = null; });
    await activeCheck;
    return { ...state };
  }

  async function download() {
    ensureSupported();
    if (activeDownload) {
      await activeDownload;
      return { ...state };
    }
    if (state.status !== 'available') throw new Error('No update is ready to download.');
    const service = initialize();
    setState('downloading', 'Downloading update…', { progress: 0 });
    activeDownload = Promise.resolve(service.downloadUpdate())
      .then((paths) => {
        if (state.status === 'downloading') {
          setState('downloaded', state.availableVersion ? `Volyx Lens ${state.availableVersion} is ready to install.` : 'The update is ready to install.', { progress: 100 });
        }
        return paths;
      })
      .catch(() => setState('error', 'The update could not be downloaded. Try again later.', { availableVersion: null }))
      .finally(() => { activeDownload = null; });
    await activeDownload;
    return { ...state };
  }

  async function install() {
    ensureSupported();
    if (state.status !== 'downloaded') throw new Error('The update is not ready to install.');
    try {
      initialize().quitAndInstall(false, true);
      return { ...state };
    } catch {
      return setState('error', 'The update could not be installed.');
    }
  }

  return {
    getState: () => ({ ...state }),
    check,
    download,
    install,
  };
}

module.exports = { createUpdateManager, SUPPORTED_PLATFORMS, releaseChannel };
