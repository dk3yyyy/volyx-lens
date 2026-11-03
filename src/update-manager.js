'use strict';

const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const { releaseUpdateFrom } = require('./release-check');

// A release that published no update metadata answers 404, and electron-updater
// reports that as a channel-file error. It is not a service outage: the build has
// no update channel any more (unsigned Windows from 0.7.5 onwards), so the useful
// answer is "get the installer from the release page", not "try again later".
const RELEASE_PAGE = 'https://github.com/dk3yyyy/volyx-lens/releases/latest';

function isMissingMetadataError(error) {
  // Keyed on the code electron-updater actually throws, never on message text:
  // an error message can quote a file name for an unrelated failure, and matching
  // it would turn a real outage into a false "go download it" instruction.
  const code = String((error && error.code) || '');
  const status = Number(error && error.statusCode);
  return code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || status === 404;
}

function manualInstallMessage() {
  return 'This build installs updates by hand. Download the newest installer from the release page.';
}

function unsupportedMessage() {
  return 'This build cannot install updates automatically. Use Open Latest Release to download the current version.';
}

function releaseChannel(platform, arch) {
  // macOS and Linux publish per-arch update metadata (latest-arm64 / latest-x64)
  // so multi-arch release assets never overwrite each other; Windows publishes a
  // single latest.yml for all architectures.
  if (platform === 'darwin' || platform === 'linux') return `latest-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  return 'latest';
}

function createUpdateManager({ app, platform = process.platform, arch = process.arch, releaseBuild = false, updaterFactory, releaseChecker = null, emit = () => {} }) {
  const packaged = Boolean(app && app.isPackaged && SUPPORTED_PLATFORMS.has(platform));
  // Installing in place needs a signed release build; learning that a release
  // exists does not. Splitting the two is what makes the Updates pane and the
  // update notification honest on an unsigned macOS DMG or Windows installer
  // instead of showing a dead toggle that can never fire.
  const installable = packaged && releaseBuild === true && typeof updaterFactory === 'function';
  const canCheck = installable || (packaged && releaseChecker != null && typeof releaseChecker.latest === 'function');
  // `supported` keeps its old meaning on the wire: this build can check at all.
  const supported = canCheck;
  // Epoch ms of the last finished check, or null before the first one. It is
  // deliberately separate from `status`: a check that failed still checked, and
  // the pane should say when that last attempt happened.
  let lastCheckedAt = null;
  let state = canCheck
    ? publicState('idle', 'Check GitHub Releases for the latest Volyx Lens version.')
    : publicState('unsupported', unsupportedMessage());
  let updater = null;
  let activeCheck = null;
  let activeDownload = null;
  // True only while a check request is in flight. The updater's 'error' event is
  // also used for download failures, and stamping lastCheckedAt there would claim
  // a check happened when only a download failed.
  let checkInFlight = false;

  function publicState(status, message, extra = {}) {
    return {
      supported,
      // False on builds that can only point at the release page, so the renderer
      // offers "get the installer" instead of a download button that would throw.
      installable,
      currentVersion: String(app && app.getVersion ? app.getVersion() : '0.0.0'),
      status,
      message,
      availableVersion: extra.availableVersion || null,
      releaseUrl: typeof extra.releaseUrl === 'string' ? extra.releaseUrl : null,
      progress: Number.isFinite(extra.progress) ? Math.max(0, Math.min(100, Math.round(extra.progress))) : null,
      // Always present so the renderer can distinguish "never checked" (null)
      // from a check that finished just now.
      lastCheckedAt: Number.isFinite(lastCheckedAt) ? lastCheckedAt : null,
    };
  }

  function setState(status, message, extra = {}) {
    // Only a terminal transition records a finished check. The 'checking' state
    // keeps the previous timestamp, so the pane can still say when it last got an
    // answer while a new request is running.
    if (extra.checked === true) lastCheckedAt = Date.now();
    state = publicState(status, message, {
      availableVersion: Object.prototype.hasOwnProperty.call(extra, 'availableVersion') ? extra.availableVersion : state.availableVersion,
      releaseUrl: Object.prototype.hasOwnProperty.call(extra, 'releaseUrl') ? extra.releaseUrl : state.releaseUrl,
      progress: extra.progress,
    });
    emit({ ...state });
    return { ...state };
  }

  function safeVersion(info) {
    const value = String(info && info.version || '').trim();
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) ? value.slice(0, 64) : null;
  }

  function ensureCanCheck() {
    if (!canCheck) throw new Error(unsupportedMessage());
  }

  function ensureInstallable() {
    if (!installable) throw new Error(manualInstallMessage());
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
      setState('available', version ? `Volyx Lens ${version} is available.` : 'A new Volyx Lens update is available.', { availableVersion: version, checked: checkInFlight });
    });
    updater.on('update-not-available', () => setState('current', 'Volyx Lens is up to date.', { availableVersion: null, checked: checkInFlight }));
    updater.on('download-progress', (progress) => {
      const percent = Number(progress && progress.percent);
      setState('downloading', Number.isFinite(percent) ? `Downloading update… ${Math.round(percent)}%` : 'Downloading update…', { progress: percent });
    });
    updater.on('update-downloaded', (info) => {
      const version = safeVersion(info) || state.availableVersion;
      setState('downloaded', version ? `Volyx Lens ${version} is ready to install.` : 'The update is ready to install.', { availableVersion: version, progress: 100 });
    });
    updater.on('error', (error) => {
      if (isMissingMetadataError(error)) {
        setState('unavailable', 'This version no longer publishes update metadata, so it cannot update itself. Download the newest installer from the release page.', { availableVersion: null, releaseUrl: RELEASE_PAGE, checked: checkInFlight });
        return;
      }
      setState('error', 'The update service is unavailable. Try again later.', { availableVersion: null, checked: checkInFlight });
    });
    return updater;
  }

  async function check() {
    ensureCanCheck();
    // Unsigned builds have no updater to drive, so they ask the public API what
    // the newest release is and stop there. Nothing is downloaded or installed.
    if (!installable) return checkPublishedRelease();
    if (activeCheck) {
      await activeCheck;
      return { ...state };
    }
    const service = initialize();
    checkInFlight = true;
    setState('checking', 'Checking for updates…', { availableVersion: null });
    activeCheck = Promise.resolve(service.checkForUpdates())
      .then((result) => {
        // checkForUpdates() can resolve without emitting either terminal event, and
        // then the UI sat on "Checking for updates…" until something else happened
        // (VR-15). If nothing has settled the state by now, settle it from the
        // result: a newer version means an update, anything else means up to date.
        if (state.status !== 'checking') return result;
        const version = safeVersion(result && result.updateInfo);
        if (version && version !== state.currentVersion) {
          setState('available', `Volyx Lens ${version} is available.`, { availableVersion: version, checked: true });
        } else {
          setState('current', 'Volyx Lens is up to date.', { availableVersion: null, checked: true });
        }
        return result;
      })
      .catch((error) => {
        if (isMissingMetadataError(error)) {
          setState('unavailable', 'This version no longer publishes update metadata, so it cannot update itself. Download the newest installer from the release page.', { availableVersion: null, releaseUrl: RELEASE_PAGE, checked: true });
          return;
        }
        setState('error', 'The update service is unavailable. Try again later.', { availableVersion: null, checked: true });
      })
      .finally(() => { checkInFlight = false; activeCheck = null; });
    await activeCheck;
    return { ...state };
  }

  async function checkPublishedRelease() {
    if (activeCheck) {
      await activeCheck;
      return { ...state };
    }
    checkInFlight = true;
    setState('checking', 'Checking for updates…', { availableVersion: null });
    activeCheck = Promise.resolve(releaseChecker.latest())
      .then((release) => {
        // The checker returns the version and URL it already validated; the pure
        // helper takes the GitHub payload shape, so map rather than duplicate the
        // comparison.
        const result = releaseUpdateFrom({
          currentVersion: state.currentVersion,
          release: release ? { tag_name: release.version, html_url: release.url } : null,
        });
        if (result.available) {
          setState('available', `Volyx Lens ${result.version} is available.`, { availableVersion: result.version, releaseUrl: result.url, checked: true });
        } else if (!release) {
          setState('current', 'No published release was found. Try again later.', { availableVersion: null, checked: true });
        } else {
          setState('current', 'Volyx Lens is up to date.', { availableVersion: null, checked: true });
        }
        return { ...state };
      })
      .catch(() => setState('error', 'GitHub could not be reached. Try again later.', { availableVersion: null, checked: true }))
      .finally(() => { checkInFlight = false; activeCheck = null; });
    await activeCheck;
    return { ...state };
  }

  async function download() {
    ensureInstallable();
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
    ensureInstallable();
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
