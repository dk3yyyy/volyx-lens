'use strict';

// The only accent themes the app accepts. Keep this list in step with the
// [data-accent-theme="…"] blocks in renderer/styles.css.
const ACCENT_THEMES = Object.freeze(['indigo', 'sage', 'ember']);
const DEFAULT_ACCENT_THEME = 'sage';

function isAccentTheme(value) {
  return typeof value === 'string' && ACCENT_THEMES.includes(value);
}

function normalizeAccentTheme(value) {
  return isAccentTheme(value) ? value : DEFAULT_ACCENT_THEME;
}

module.exports = { ACCENT_THEMES, DEFAULT_ACCENT_THEME, isAccentTheme, normalizeAccentTheme };
