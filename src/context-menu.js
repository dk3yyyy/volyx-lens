'use strict';

// Context menus, as data.
//
// The template is built in a pure function so the menu shape can be tested
// without an Electron window, and main.js keeps only the few lines that turn a
// descriptor into a Menu. Items carry an id the renderer acts on, except role
// items, which the platform performs itself: those are what make Cut/Copy/Paste
// and Undo work inside text fields, which a window with no application menu
// otherwise loses.

const EDITABLE_ITEMS = [
  { role: 'undo', label: 'Undo' },
  { role: 'redo', label: 'Redo' },
  { type: 'separator' },
  { role: 'cut', label: 'Cut' },
  { role: 'copy', label: 'Copy' },
  { role: 'paste', label: 'Paste' },
  { role: 'selectAll', label: 'Select All' },
];

const KINDS = new Set(['editable', 'transcript-turn', 'history-row', 'answer']);

function contextMenuTemplate(kind, options = {}) {
  if (!KINDS.has(kind)) return [];
  if (kind === 'editable') return EDITABLE_ITEMS.map((item) => ({ ...item }));
  if (kind === 'transcript-turn') {
    const hasTurn = options.hasTurn !== false;
    const hasConversation = options.hasConversation !== false;
    return [
      { id: 'copy-turn', label: 'Copy This Turn', enabled: hasTurn },
      { id: 'copy-conversation', label: 'Copy Conversation', enabled: hasConversation },
      { type: 'separator' },
      { id: 'export-transcript', label: 'Export Transcript…', enabled: hasConversation },
    ];
  }
  if (kind === 'answer') {
    const hasAnswer = options.hasAnswer !== false;
    return [
      { id: 'copy-answer', label: 'Copy Answer', enabled: hasAnswer },
      { id: 'copy-answer-and-question', label: 'Copy Answer with Question', enabled: hasAnswer && options.hasQuestion !== false },
    ];
  }
  return [
    { id: 'open', label: 'Open Meeting' },
    { id: 'export-md', label: 'Export as Markdown…', enabled: options.canExport !== false },
    { id: 'backup-all', label: 'Back Up All Meetings…' },
  ];
}

module.exports = { contextMenuTemplate, KINDS };
