const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAccelerator,
  eventToAccelerator,
  isValidAccelerator,
  isReservedAccelerator,
  findConflicts,
  validateRemap,
  sanitizeShortcutsPatch,
  applyShortcuts,
} = require('../src/shortcut-validator');

test('normalizeAccelerator normalizes modifiers and rejects invalid keys', () => {
  assert.equal(normalizeAccelerator('ctrl+shift+a'), 'Control+Shift+A');
  assert.equal(normalizeAccelerator('commandorcontrol+return'), 'CommandOrControl+Return');
  assert.equal(normalizeAccelerator('Alt+Tab'), 'Alt+Tab');
  assert.equal(normalizeAccelerator('Meta+Shift+.'), 'Meta+Shift+.');
  assert.equal(normalizeAccelerator('ctrl'), null);
  assert.equal(normalizeAccelerator(''), null);
  assert.equal(normalizeAccelerator(null), null);
  assert.equal(normalizeAccelerator('ctrl+alt'), null);
  assert.equal(normalizeAccelerator('+'), null);
});

test('eventToAccelerator converts keyboard events with platform modifiers', () => {
  const fakeEvent = { ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, key: 'A' };
  assert.equal(eventToAccelerator(fakeEvent), 'Control+Shift+A');
  const altEvent = { ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, key: 'Tab' };
  assert.equal(eventToAccelerator(altEvent), 'Alt+Tab');
  const metaEvent = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: true, key: 'H' };
  assert.equal(eventToAccelerator(metaEvent), 'Meta+H');
  const noMod = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, key: 'A' };
  assert.equal(eventToAccelerator(noMod), null);
  const space = { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, key: ' ' };
  assert.equal(eventToAccelerator(space), 'Control+Space');
});

test('isValidAccelerator accepts valid keys and rejects invalid ones', () => {
  assert.equal(isValidAccelerator('Control+A'), true);
  assert.equal(isValidAccelerator('CommandOrControl+F12'), true);
  assert.equal(isValidAccelerator('Alt+Tab'), true);
  assert.equal(isValidAccelerator('Control+Shift+.'), true);
  assert.equal(isValidAccelerator('Control+Escap'), false);
  assert.equal(isValidAccelerator('Control+KeyA'), false);
  assert.equal(isValidAccelerator('A'), false);
  assert.equal(isValidAccelerator(''), false);
});

test('isReservedAccelerator flags system shortcuts per platform', () => {
  assert.equal(isReservedAccelerator('Control+Space', 'darwin'), true);
  assert.equal(isReservedAccelerator('Control+Alt+L', 'linux'), true);
  assert.equal(isReservedAccelerator('Control+Alt+Delete', 'win32'), true);
  assert.equal(isReservedAccelerator('Control+Space', 'linux'), false);
  assert.equal(isReservedAccelerator('Control+A', 'darwin'), false);
});

test('findConflicts detects duplicate accelerators and system conflicts', () => {
  const defs = [
    { id: 'a', accelerator: 'Control+A' },
    { id: 'b', accelerator: 'Control+B' },
    { id: 'c', accelerator: 'Control+A' },
  ];
  const conflicts = findConflicts(defs, 'darwin');
  const dup = conflicts.find((c) => c.kind === 'duplicate');
  assert.ok(dup);
  assert.deepEqual(dup.ids.sort(), ['a', 'c']);
  assert.equal(dup.accelerator, 'Control+A');
});

test('validateRemap rejects invalid, reserved, and duplicate accelerators', () => {
  const defs = [
    { id: 'a', accelerator: 'Control+A' },
    { id: 'b', accelerator: 'Control+B' },
  ];
  const invalid = validateRemap({ id: 'a', accelerator: 'Control+Escape', definitions: defs });
  assert.equal(invalid.ok, true);
  const reserved = validateRemap({ id: 'a', accelerator: 'Control+Space', definitions: defs, platform: 'darwin' });
  assert.equal(reserved.ok, false);
  assert.match(reserved.error, /reserved/);
  const dup = validateRemap({ id: 'a', accelerator: 'Control+B', definitions: defs, platform: 'darwin' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /in use/);
  const valid = validateRemap({ id: 'a', accelerator: 'Control+Shift+X', definitions: defs, platform: 'darwin' });
  assert.equal(valid.ok, true);
  assert.equal(valid.accelerator, 'Control+Shift+X');
});

test('sanitizeShortcutsPatch filters invalid overrides and preserves valid ones', () => {
  const defaults = [
    { id: 'assist', accelerator: 'CommandOrControl+Return' },
    { id: 'solve', accelerator: 'CommandOrControl+H' },
    { id: 'task-context', accelerator: 'CommandOrControl+Shift+C' },
    { id: 'quit', accelerator: 'CommandOrControl+Shift+X' },
  ];
  const patch = {
    assist: 'Control+Shift+Q',
    solve: 'Control+Space',
    unknown: 'Control+Z',
    quit: 'Control+Alt+Four',
  };
  const { valid, invalid } = sanitizeShortcutsPatch({ patch, defaultDefinitions: defaults, platform: 'darwin' });
  assert.equal(valid.assist, 'Control+Shift+Q');
  assert.equal(valid.solve, undefined);
  assert.equal(valid.unknown, undefined);
  assert.equal(valid.quit, undefined);
  const ids = invalid.map((i) => i.id).sort();
  assert.deepEqual(ids, ['quit', 'solve', 'unknown']);
});

test('applyShortcuts merges overrides onto defaults', () => {
  const defaults = [
    { id: 'assist', accelerator: 'CommandOrControl+Return', mac: '⌘↵' },
    { id: 'solve', accelerator: 'CommandOrControl+H', mac: '⌘H' },
  ];
  const result = applyShortcuts({ defaultDefinitions: defaults, overrides: { assist: 'Control+Shift+Q' } });
  assert.equal(result[0].accelerator, 'Control+Shift+Q');
  assert.equal(result[1].accelerator, 'CommandOrControl+H');
  assert.equal(result[0].mac, '⌘↵');
});

test('two shortcuts can be swapped in one patch', () => {
  // Non-reserved keys, because macOS reserves Command+H and the UI is right to
  // refuse that half of the swap regardless of ordering.
  const defaults = [
    { id: 'first', accelerator: 'CommandOrControl+J' },
    { id: 'second', accelerator: 'CommandOrControl+K' },
  ];
  const { valid, invalid } = sanitizeShortcutsPatch({
    patch: { first: 'CommandOrControl+K', second: 'CommandOrControl+J' },
    defaultDefinitions: defaults,
    platform: 'darwin',
  });
  assert.deepEqual(invalid, [], 'neither move collides with a default the other is giving up');
  assert.deepEqual(valid, { first: 'CommandOrControl+K', second: 'CommandOrControl+J' }, 'both swaps persist');
});

test('a swap onto a key the system owns is still refused, with the right reason', () => {
  const defaults = [
    { id: 'assist', accelerator: 'CommandOrControl+Return' },
    { id: 'solve', accelerator: 'CommandOrControl+J' },
  ];
  const { valid, invalid } = sanitizeShortcutsPatch({
    patch: { assist: 'CommandOrControl+H', solve: 'CommandOrControl+Return' },
    defaultDefinitions: defaults,
    platform: 'darwin',
  });
  // Command+H is Hide on macOS, so assist cannot take it. assist then keeps its
  // default Command+Return, which is exactly what solve asked for, so solve is a
  // genuine duplicate and stays refused, each with its own reason.
  assert.deepEqual(valid, {});
  assert.equal(invalid.length, 2);
  assert.match(invalid.find((entry) => entry.id === 'assist').error, /reserved by the operating system/);
  assert.match(invalid.find((entry) => entry.id === 'solve').error, /already in use/);
});

test('a genuine duplicate is still rejected, from either direction', () => {
  const defaults = [
    { id: 'assist', accelerator: 'CommandOrControl+Return' },
    { id: 'solve', accelerator: 'CommandOrControl+H' },
  ];
  const forward = sanitizeShortcutsPatch({
    patch: { assist: 'CommandOrControl+J', solve: 'CommandOrControl+J' },
    defaultDefinitions: defaults,
    platform: 'darwin',
  });
  assert.deepEqual(forward.valid, {}, 'two shortcuts cannot share one key');
  assert.equal(forward.invalid.length, 2, 'both entries are reported so the UI can explain it');

  // The same collision declared in the other order behaves the same way.
  const backward = sanitizeShortcutsPatch({
    patch: { solve: 'CommandOrControl+J', assist: 'CommandOrControl+J' },
    defaultDefinitions: defaults,
    platform: 'darwin',
  });
  assert.deepEqual(backward.valid, {});
});

test('a swap still rejects the entry that collides with an untouched shortcut', () => {
  const defaults = [
    { id: 'assist', accelerator: 'CommandOrControl+Return' },
    { id: 'solve', accelerator: 'CommandOrControl+H' },
    { id: 'quit', accelerator: 'CommandOrControl+Shift+X' },
  ];
  const { valid, invalid } = sanitizeShortcutsPatch({
    patch: { assist: 'CommandOrControl+Shift+X' },
    defaultDefinitions: defaults,
    platform: 'darwin',
  });
  assert.deepEqual(valid, {}, 'quit keeps its key');
  assert.equal(invalid[0].id, 'assist');
  assert.match(invalid[0].error, /already in use/);
});
