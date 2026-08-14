const PRIVACY_PANES = Object.freeze({
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
});

const SUPPORTED_KINDS = new Set(['microphone', 'screen']);

function assertPermissionKind(kind) {
  if (!Object.prototype.hasOwnProperty.call(PRIVACY_PANES, kind)) {
    throw new Error(`Unsupported permission type: ${kind}`);
  }
}

// Chromium manages media permission on Windows/Linux through the browser-style
// prompt (already wired in main.js via setPermissionRequestHandler). There is no
// OS-level toggle or settings pane, so status is 'not-determined' (prompt shown
// on first use) rather than macOS's TCC 'unsupported'.
function browserManagedPermissionStatus(kind, isPackaged) {
  return {
    kind,
    status: 'not-determined',
    granted: false,
    developmentClient: isPackaged !== true,
  };
}

function mediaPermissionStatus(kind, dependencies) {
  assertPermissionKind(kind);
  const {
    platform = process.platform,
    systemPreferences,
    isPackaged = true,
  } = dependencies;
  if (platform !== 'darwin') return browserManagedPermissionStatus(kind, isPackaged);
  const status = systemPreferences.getMediaAccessStatus(kind);
  return {
    kind,
    status,
    granted: status === 'granted',
    developmentClient: isPackaged !== true,
  };
}

async function requestMediaPermission(kind, dependencies) {
  assertPermissionKind(kind);

  const {
    platform = process.platform,
    systemPreferences,
    desktopCapturer,
    openExternal,
    isPackaged = true,
  } = dependencies;

  if (platform !== 'darwin') {
    // On Windows/Linux, screen capture via desktopCapturer is available without
    // an OS-level grant; the browser-style media prompt covers the microphone.
    // Trigger desktopCapturer so the OS capture surface (portal on Linux) is
    // exercised, then report the outcome.
    let granted = kind === 'screen';
    let status = 'not-determined';
    if (kind === 'screen') {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
        granted = Array.isArray(sources) && sources.length > 0;
        status = granted ? 'granted' : 'not-determined';
      } catch {
        granted = false;
        status = 'denied';
      }
    }
    return {
      kind,
      granted,
      status,
      settingsOpened: false,
      developmentClient: isPackaged !== true,
      message: granted
        ? undefined
        : 'The browser prompt for ' + (kind === 'microphone' ? 'microphone' : 'screen') + ' access will appear when you start using Volyx Lens.',
    };
  }

  let status = systemPreferences.getMediaAccessStatus(kind);
  const developmentClient = isPackaged !== true;
  if (status === 'granted') {
    return { kind, granted: true, status, settingsOpened: false, developmentClient };
  }

  if (kind === 'microphone' && status === 'not-determined') {
    await systemPreferences.askForMediaAccess('microphone');
    status = systemPreferences.getMediaAccessStatus('microphone');
  }

  if (kind === 'screen' && status === 'not-determined') {
    try {
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      });
    } catch {
      // The authoritative result is the TCC status checked below.
    }
    status = systemPreferences.getMediaAccessStatus('screen');
  }

  const granted = status === 'granted';
  let settingsOpened = false;
  if (!granted) {
    await openExternal(PRIVACY_PANES[kind]);
    settingsOpened = true;
  }

  const message = !granted && developmentClient
    ? 'This npm start development build is a separate macOS permission client. Quit it and open the packaged app; a grant for Volyx Lens.app does not apply to this process.'
    : undefined;
  return { kind, granted, status, settingsOpened, developmentClient, ...(message ? { message } : {}) };
}

module.exports = { PRIVACY_PANES, SUPPORTED_KINDS, mediaPermissionStatus, requestMediaPermission };
