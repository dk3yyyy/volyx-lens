const PRIVACY_PANES = Object.freeze({
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
});

function assertPermissionKind(kind) {
  if (!Object.prototype.hasOwnProperty.call(PRIVACY_PANES, kind)) {
    throw new Error(`Unsupported permission type: ${kind}`);
  }
}

function mediaPermissionStatus(kind, dependencies) {
  assertPermissionKind(kind);
  const {
    platform = process.platform,
    systemPreferences,
    isPackaged = true,
  } = dependencies;
  if (platform !== 'darwin') {
    return { kind, status: 'unsupported', granted: false, developmentClient: false };
  }
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
    return {
      kind,
      granted: false,
      status: 'unsupported',
      settingsOpened: false,
      developmentClient: false,
      message: 'Media permission prompts are only available on macOS.',
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

module.exports = { PRIVACY_PANES, mediaPermissionStatus, requestMediaPermission };
