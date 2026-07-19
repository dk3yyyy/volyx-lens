const test = require('node:test');
const assert = require('node:assert/strict');
const { createShortcutRegistry } = require('../src/shortcut-registry');

function definitions() {
  return [
    { id: 'assist', accelerator: 'CommandOrControl+Return', mac: '⌘↵', other: 'Ctrl+Enter', feature: 'Assist', fallback: 'Use Assist button', handler() {} },
    { id: 'solve', accelerator: 'CommandOrControl+H', mac: '⌘H', other: 'Ctrl+H', feature: 'Solve screen', fallback: 'Use Solve button', handler() {} },
    { id: 'capture', accelerator: 'CommandOrControl+Shift+C', mac: '⌘⇧C', other: 'Ctrl+Shift+C', feature: 'Add screen', fallback: 'Use Add screen button', handler() {} },
  ];
}

test('shortcut registry reports successful and unavailable registrations without guessing conflict ownership', () => {
  const registered = new Set();
  const adapter = {
    register(accelerator) {
      if (accelerator.endsWith('+H')) return false;
      if (accelerator.endsWith('+Shift+C')) throw new Error('raw operating-system detail');
      registered.add(accelerator);
      return true;
    },
    isRegistered(accelerator) { return registered.has(accelerator); },
  };
  const registry = createShortcutRegistry({ globalShortcut: adapter, platform: 'darwin', definitions: definitions() });
  const result = registry.register();

  assert.deepEqual(result.map((entry) => [entry.id, entry.registered, entry.displayAccelerator]), [
    ['assist', true, '⌘↵'],
    ['solve', false, '⌘H'],
    ['capture', false, '⌘⇧C'],
  ]);
  assert.match(result[1].message, /macOS, the operating system, or another application may own/);
  assert.doesNotMatch(JSON.stringify(result), /raw operating-system detail/);
  assert.equal(result[1].fallback, 'Use Solve button');
});

test('retry leaves healthy shortcuts registered and retries only unavailable or lost entries', () => {
  const registered = new Set();
  const calls = new Map();
  let solveAvailable = false;
  const adapter = {
    register(accelerator) {
      calls.set(accelerator, (calls.get(accelerator) || 0) + 1);
      if (accelerator.endsWith('+H') && !solveAvailable) return false;
      registered.add(accelerator);
      return true;
    },
    isRegistered(accelerator) { return registered.has(accelerator); },
  };
  const defs = definitions().slice(0, 2);
  const registry = createShortcutRegistry({ globalShortcut: adapter, platform: 'linux', definitions: defs });

  assert.deepEqual(registry.register().map((entry) => entry.registered), [true, false]);
  solveAvailable = true;
  assert.deepEqual(registry.register().map((entry) => entry.registered), [true, true]);
  assert.equal(calls.get('CommandOrControl+Return'), 1);
  assert.equal(calls.get('CommandOrControl+H'), 2);

  registered.delete('CommandOrControl+Return');
  const lost = registry.status();
  assert.equal(lost[0].registered, false);
  assert.equal(lost[0].displayAccelerator, 'Ctrl+Enter');
  registry.register();
  assert.equal(calls.get('CommandOrControl+Return'), 2);
});

test('shortcut registry validates its global shortcut adapter', () => {
  assert.throws(() => createShortcutRegistry({ globalShortcut: {}, platform: 'darwin', definitions: [] }), /globalShortcut adapter/);
});
