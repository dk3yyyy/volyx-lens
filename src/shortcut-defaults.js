// Default global shortcut definitions shared between the main process and the
// settings store. Kept in its own module so both can validate against the same
// source of truth.
const DEFAULT_SHORTCUT_DEFS = [
  { id: 'assist', accelerator: 'CommandOrControl+Return', mac: '⌘↵', other: 'Ctrl+Enter', feature: 'Assist', fallback: 'Use Assist button' },
  { id: 'solve', accelerator: 'CommandOrControl+H', mac: '⌘H', other: 'Ctrl+H', feature: 'Solve screen', fallback: 'Use Solve button' },
  { id: 'task-context', accelerator: 'CommandOrControl+Shift+C', mac: '⌘⇧C', other: 'Ctrl+Shift+C', feature: 'Add screen', fallback: 'Use Add screen button' },
  { id: 'quit', accelerator: 'CommandOrControl+Shift+X', mac: '⌘⇧X', other: 'Ctrl+Shift+X', feature: 'Stop all and quit', fallback: 'Use power button' },
];

module.exports = { DEFAULT_SHORTCUT_DEFS };
