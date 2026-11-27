// Capture-device guards shared by the renderer's system-audio and microphone
// paths.
//
// Two independent integrity problems live here:
//  * Windows loopback capture records every render endpoint, including the
//    app's own speech output, unless Chromium is asked to exclude it. The
//    constraint only exists on Windows, so other platforms must keep the plain
//    audio request.
//  * A selected microphone can report zero input channels. The stream then
//    opens and records digital silence, which looks like a quiet meeting. Such
//    a device is rejected in favour of the system default.
//
// Loaded as a plain script by the renderer and required directly by tests, the
// same way renderer/notes-markup.js is.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.volyxLensCaptureGuards = api;
})(typeof window !== 'undefined' ? window : null, () => {
  const WINDOWS_PLATFORM = 'win32';

  // getDisplayMedia constraints for loopback audio. `restrictOwnAudio` is a
  // Windows-only Chromium option: requesting it elsewhere is at best ignored
  // and at worst makes the request fail, so it is only sent where it works.
  function displayMediaConstraints(platform, { video = true } = {}) {
    if (platform === WINDOWS_PLATFORM) return { video, audio: { restrictOwnAudio: true } };
    return { video, audio: true };
  }

  function channelCountOf(input) {
    if (!input) return null;
    let settings = input;
    if (typeof input.getSettings === 'function') {
      try { settings = input.getSettings(); } catch { return null; }
    }
    if (!settings || settings.channelCount === undefined || settings.channelCount === null) return null;
    const count = Number(settings.channelCount);
    return Number.isFinite(count) ? count : null;
  }

  // Only an explicit zero is treated as unusable. Devices and browsers that do
  // not report a channel count must stay selectable, otherwise this guard would
  // reject working microphones.
  function hasNoInputChannels(input) {
    return channelCountOf(input) === 0;
  }

  function isSelectableInput(device) {
    if (!device || device.kind !== 'audioinput') return false;
    return !(Number(device.channelCount) === 0);
  }

  // Chooses the microphone to open. A saved device that is gone, or that
  // advertises zero input channels, falls back to the system default and
  // reports why so the caller can surface the reason.
  function chooseInputDevice(devices, requestedId) {
    const list = Array.isArray(devices) ? devices : [];
    if (!requestedId) return { deviceId: '', rejected: null };
    if (list.some((device) => isSelectableInput(device) && device.deviceId === requestedId)) {
      return { deviceId: requestedId, rejected: null };
    }
    const requested = list.find((device) => device && device.kind === 'audioinput' && device.deviceId === requestedId);
    return { deviceId: '', rejected: requested ? 'no-input-channels' : 'unavailable' };
  }

  // Checked against the opened track, because MediaDeviceInfo does not expose a
  // channel count. A zero-channel requested device means the stream would be
  // silent, so the caller should close it and reopen the default device.
  function inputDeviceFallback(requestedId, track) {
    if (!requestedId || !hasNoInputChannels(track)) return null;
    return {
      deviceId: '',
      reason: 'no-input-channels',
      message: 'The selected microphone reports no input channels. Using the system default microphone instead.',
    };
  }

  return {
    WINDOWS_PLATFORM,
    displayMediaConstraints,
    channelCountOf,
    hasNoInputChannels,
    isSelectableInput,
    chooseInputDevice,
    inputDeviceFallback,
  };
});
