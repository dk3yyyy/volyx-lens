// Apply the saved/system theme before the body renders, so there is no flash
// of the wrong theme while the page is painting. Run inline in <head>.
(function () {
  var KEY = 'volyx-lens-theme';
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved !== 'light' && saved !== 'dark') {
    saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  var root = document.documentElement;
  root.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
  // Disable the CSS transition for the first paint, so the page lands in
  // the right theme without visibly animating from the wrong one.
  root.setAttribute('data-theme-initial', 'pending');
  requestAnimationFrame(function () {
    root.removeAttribute('data-theme-initial');
  });
})();
