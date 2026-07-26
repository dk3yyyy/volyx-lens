const test = require('node:test');
const assert = require('node:assert/strict');

const { createWindowAutoFitController } = require('../src/window-auto-fit');

function fakeTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimer(callback, delay) {
      const id = ++nextId;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { pending.delete(id); },
    pending,
    run(id) {
      const task = pending.get(id);
      pending.delete(id);
      task.callback();
    },
  };
}

function controllerHarness() {
  const timers = fakeTimers();
  const fittedPoints = [];
  const controller = createWindowAutoFitController({
    delayMs: 700,
    fit: (point) => fittedPoints.push(point),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { controller, fittedPoints, timers };
}

test('every manual movement refreshes the quiet timer and only the final cursor point fits', () => {
  const { controller, fittedPoints, timers } = controllerHarness();
  controller.beginManualMove();
  assert.equal(controller.recordMove({ x: 100, y: 100 }), true);
  const firstTimer = [...timers.pending.keys()][0];
  assert.equal(timers.pending.get(firstTimer).delay, 700);

  controller.beginManualMove();
  assert.equal(controller.recordMove({ x: 900, y: 500 }), true);
  assert.equal(timers.pending.has(firstTimer), false);
  assert.equal(timers.pending.size, 1);
  assert.deepEqual(fittedPoints, []);

  const finalTimer = [...timers.pending.keys()][0];
  timers.run(finalTimer);
  assert.deepEqual(fittedPoints, [{ x: 900, y: 500 }]);
  assert.equal(controller.pending, false);
  assert.equal(controller.moving, false);
});

test('programmatic movement without a manual will-move signal is ignored', () => {
  const { controller, fittedPoints, timers } = controllerHarness();
  assert.equal(controller.recordMove({ x: 500, y: 300 }), false);
  assert.equal(timers.pending.size, 0);
  assert.deepEqual(fittedPoints, []);
});

test('cancel invalidates pending intent across collapse, modal, and close transitions', () => {
  const { controller, fittedPoints, timers } = controllerHarness();
  controller.beginManualMove();
  controller.recordMove({ x: 500, y: 300 });
  controller.cancel();

  assert.equal(timers.pending.size, 0);
  assert.equal(controller.pending, false);
  assert.equal(controller.moving, false);
  assert.equal(controller.recordMove({ x: 700, y: 400 }), false);
  assert.deepEqual(fittedPoints, []);
});
