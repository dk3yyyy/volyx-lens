'use strict';

function operationInProgressError(label) {
  const error = new Error(`Wait for the current local speech model ${label || 'operation'} to finish.`);
  error.code = 'speech_model_operation_in_progress';
  return error;
}

function createSpeechOperationGate() {
  let active = null;

  function run(label, operation) {
    if (active) return Promise.reject(operationInProgressError(label));
    if (typeof operation !== 'function') return Promise.reject(new TypeError('A speech model operation is required.'));
    const task = Promise.resolve().then(operation);
    active = task;
    const clear = () => { if (active === task) active = null; };
    task.then(clear, clear);
    return task;
  }

  async function whenIdle() {
    while (active) {
      try { await active; } catch {}
    }
  }

  return {
    run,
    whenIdle,
    isBusy: () => Boolean(active),
  };
}

module.exports = { createSpeechOperationGate };
