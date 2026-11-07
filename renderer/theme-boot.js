(function bootstrapAccentTheme() {
  var known = { indigo: true, sage: true, ember: true };
  var hasOwn = Object.prototype.hasOwnProperty;
  var hint = null;
  var reloaded = false;
  try {
    hint = window.localStorage.getItem('volyx.accentTheme');
  } catch (error) {
    hint = null;
  }
  try {
    reloaded = window.sessionStorage.getItem('volyx.themeBooted') === '1';
  } catch (error) {
    reloaded = false;
  }
  var argument = window.volyxLens && window.volyxLens.initialAccentTheme;
  var value;
  var source;
  if (reloaded && hasOwn.call(known, hint)) {
    // A reload reuses the launch argument, which can be one save behind the
    // store. The hint is written after a successful save, so it wins here.
    value = hint;
    source = 'hint';
  } else if (hasOwn.call(known, argument)) {
    // A cold start reads the store before the window is created. The hint may
    // belong to an older session or a hand-edited setting, so it does not win.
    value = argument;
    source = 'argv';
  } else if (hasOwn.call(known, hint)) {
    value = hint;
    source = 'hint';
  } else {
    value = 'indigo';
    source = 'default';
  }
  document.documentElement.setAttribute('data-accent-theme', value);
  window.__volyxThemeBoot = { theme: value, source: source };
  try {
    window.sessionStorage.setItem('volyx.themeBooted', '1');
  } catch (error) {
    // Session storage can be blocked; the argument remains a safe fallback.
  }
})();
