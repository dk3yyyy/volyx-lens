// Them-channel digital-silence watchdog.
//
// A system-audio source can keep delivering frames after the audio path behind
// it dies: a Bluetooth output disconnect, a default-sink change, or a helper
// that stops reading its stream. The frames are exact zeros, so the channel
// still looks connected while the remote side silently disappears from the
// transcript. This tracks whether the channel has carried real audio during
// the capture session, then reports one episode when a run of exact digital
// silence follows it.
//
// The threshold is deliberately "exactly zero" rather than a low RMS: a quiet
// but live room/loopback still has a noise floor, and treating that as silence
// would reconnect a healthy source. Only all-zero PCM proves the path is dead.
//
// Loaded by main.js (which sees every Them buffer) and required directly by
// tests, the same way renderer/notes-markup.js is loaded by the renderer.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.volyxLensThemSilenceWatchdog = api;
})(typeof window !== 'undefined' ? window : null, () => {
  // RMS in Int16 units. About -66 dBFS: above digital silence, below anything
  // a working loopback would carry as speech.
  const DEFAULT_SOUND_FLOOR = 16;
  const DEFAULT_SILENCE_MS = 15000;
  const DEFAULT_RETRY_COOLDOWN_MS = 30000;

  function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function createThemSilenceWatchdog({
    silenceMs = DEFAULT_SILENCE_MS,
    retryCooldownMs = DEFAULT_RETRY_COOLDOWN_MS,
    soundFloor = DEFAULT_SOUND_FLOOR,
    now = () => Date.now(),
    onSilence = () => {},
    restart = null,
  } = {}) {
    const silenceThreshold = positiveNumber(silenceMs, DEFAULT_SILENCE_MS);
    const cooldown = positiveNumber(retryCooldownMs, DEFAULT_RETRY_COOLDOWN_MS);
    const floor = positiveNumber(soundFloor, DEFAULT_SOUND_FLOOR);

    let armed = false;
    let carriedSound = false;
    let silentSince = null;
    let noticeSent = false;
    let restartAttempted = false;
    let lastRestartAt = null;
    let notices = 0;
    let restarts = 0;

    // Episode state is everything a new capture session, a new transcript
    // session, or a source restart must forget. The restart timestamp is not
    // episode state: keeping it is what bounds retries across episodes.
    function clearEpisode() {
      carriedSound = false;
      silentSince = null;
      noticeSent = false;
      restartAttempted = false;
    }

    function arm(enabled = true) {
      armed = enabled === true;
      clearEpisode();
    }

    function disarm() {
      armed = false;
      clearEpisode();
    }

    // Session change / source restart while capture continues.
    function reset() {
      clearEpisode();
    }

    function attemptRestart(at) {
      if (typeof restart !== 'function' || restartAttempted) return;
      if (lastRestartAt !== null && at - lastRestartAt < cooldown) return;
      restartAttempted = true;
      lastRestartAt = at;
      restarts += 1;
      try {
        restart({ silentForMs: at - silentSince });
      } catch {
        // A restart hook that throws must not break the PCM path.
      }
    }

    function evaluate(at) {
      if (!armed || !carriedSound || silentSince === null) return;
      if (at - silentSince < silenceThreshold) return;
      if (!noticeSent) {
        noticeSent = true;
        notices += 1;
        try {
          onSilence({ silentForMs: at - silentSince });
        } catch {
          // A listener that throws must not break the PCM path.
        }
      }
      attemptRestart(at);
    }

    // feed(rms) is called once per Them PCM buffer with its RMS in Int16-ish
    // units. A malformed value is ignored rather than counted as silence.
    function feed(rms) {
      if (!armed) return;
      const level = Number(rms);
      if (!Number.isFinite(level) || level < 0) return;
      const at = now();
      if (level > floor) {
        // Sound carried again: the previous episode is over, so a later run of
        // zeros is a new episode and may notice (subject to the cooldown).
        carriedSound = true;
        silentSince = null;
        noticeSent = false;
        restartAttempted = false;
        return;
      }
      if (!carriedSound) return;
      if (level > 0) {
        // Low-level noise is not digital silence. It breaks the continuous run
        // without ending the episode or re-arming the notice.
        silentSince = null;
        return;
      }
      if (silentSince === null) silentSince = at;
      evaluate(at);
    }

    // Allows a timer to evaluate a zero run even when the caller does not feed
    // another buffer (the run itself is still measured by frame timestamps).
    function tick() {
      evaluate(now());
    }

    function status() {
      return {
        armed,
        carriedSound,
        silentForMs: silentSince === null ? 0 : Math.max(0, now() - silentSince),
        noticeSent,
        restartAttempted,
        lastRestartAt,
        notices,
        restarts,
      };
    }

    return { arm, disarm, reset, feed, tick, status };
  }

  return { createThemSilenceWatchdog, DEFAULT_SOUND_FLOOR, DEFAULT_SILENCE_MS, DEFAULT_RETRY_COOLDOWN_MS };
});
