const PRIVACY_PANES = Object.freeze({
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
});

async function requestMediaPermission(kind, dependencies) {
  if (!Object.prototype.hasOwnProperty.call(PRIVACY_PANES, kind)) {
    throw new Error(`Unsupported permission type: ${kind}`);
  }

  const {
    platform = process.platform,
    systemPreferences,
    desktopCapturer,
    openExternal,
  } = dependencies;

  if (platform !== 'darwin') {
    return {
      kind,
      granted: false,
      status: 'unsupported',
      settingsOpened: false,
      message: 'Media permission prompts are only available on macOS.',
    };
  }

  let status = systemPreferences.getMediaAccessStatus(kind);
  if (status === 'granted') {
    return { kind, granted: true, status, settingsOpened: false };
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

  return { kind, granted, status, settingsOpened };
}

module.exports = { PRIVACY_PANES, requestMediaPermission };
