(function bootstrapAccentTheme() {
  var known = { indigo: true, sage: true, ember: true };
  var value = null;
  try {
    value = window.localStorage.getItem('volyx.accentTheme');
  } catch (error) {
    value = null;
  }
  if (!known[value] && window.volyxLens) value = window.volyxLens.initialAccentTheme;
  if (!known[value]) value = 'indigo';
  document.documentElement.setAttribute('data-accent-theme', value);
})();
