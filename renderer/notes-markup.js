// Meeting notes markup.
//
// The notes come from a model reading a transcript, and a transcript can contain
// anything a speaker said, including text that looks like markup. Building this
// pane by concatenating HTML therefore lets a transcript steer what the renderer
// shows. Every value is escaped here.
//
// Loaded as a plain script by the renderer and required directly by tests, the
// same way renderer/plain-math.js is.
(function exposeNotesMarkup(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.volyxLensNotesMarkup = api;
})(typeof window !== 'undefined' ? window : null, () => {
  const SECTIONS = [
    { key: 'summary', title: 'Meeting Summary', icon: '📋' },
    { key: 'keyPoints', title: 'Key Points', icon: '💡' },
    { key: 'decisions', title: 'Decisions', icon: '✅' },
    { key: 'actionItems', title: 'Action Items', icon: '🎯' },
    { key: 'followUp', title: 'Follow-Up', icon: '🔄' },
  ];

  const ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

  function escapeText(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
  }

  function itemsFor(value) {
    if (Array.isArray(value)) return value.filter((item) => item != null && String(item).trim() !== '');
    return value ? [value] : [];
  }

  function renderNotesHtml(notes, rawText = '') {
    if (!notes) {
      return `<div><pre class="notes-raw">${escapeText(rawText)}</pre></div>`;
    }
    let html = '<div class="notes-structured">';
    for (const section of SECTIONS) {
      const items = itemsFor(notes[section.key]);
      if (!items.length) continue;
      html += '<section class="notes-section">';
      html += `<h4>${section.icon} ${section.title}</h4>`;
      if (section.key === 'summary') {
        html += `<p>${escapeText(items[0])}</p>`;
      } else {
        html += '<ul>';
        for (const item of items) html += `<li>${escapeText(item)}</li>`;
        html += '</ul>';
      }
      html += '</section>';
    }
    html += '</div>';
    return html;
  }

  return { renderNotesHtml, escapeText, SECTIONS };
});
