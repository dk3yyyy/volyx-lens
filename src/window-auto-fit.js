'use strict';

const DEFAULT_AUTO_FIT_DELAY_MS = 700;

function createWindowAutoFitController({
  fit,
  delayMs = DEFAULT_AUTO_FIT_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof fit !== 'function') throw new TypeError('fit must be a function');

  let timer = null;
  let manualMove = false;
  let latestIntentPoint = null;

  function clearPendingTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function cancel() {
    clearPendingTimer();
    manualMove = false;
    latestIntentPoint = null;
  }

  function beginManualMove() {
    manualMove = true;
    clearPendingTimer();
  }

  function recordMove(intentPoint) {
    if (!manualMove || !intentPoint) return false;
    latestIntentPoint = intentPoint;
    clearPendingTimer();
    timer = setTimer(() => {
      timer = null;
      const finalIntentPoint = latestIntentPoint;
      manualMove = false;
      latestIntentPoint = null;
      if (finalIntentPoint) fit(finalIntentPoint);
    }, Math.max(0, Number(delayMs) || 0));
    return true;
  }

  return {
    beginManualMove,
    recordMove,
    cancel,
    get pending() { return timer !== null; },
    get moving() { return manualMove; },
  };
}

module.exports = { DEFAULT_AUTO_FIT_DELAY_MS, createWindowAutoFitController };
