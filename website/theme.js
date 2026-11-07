// Apply the saved/system theme before the body renders, so there is no flash
// of the wrong theme while the page is painting. Run inline in <head>.
(function () {
  var KEY = 'volyx-lens-theme';
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  // No stored choice: follow the operating system and let the toggle override it.
  if (saved !== 'light' && saved !== 'dark') {
    saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  var root = document.documentElement;
  root.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
  // Keep the browser chrome in step with the theme before first paint.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', saved === 'light' ? '#eef0ea' : '#141816');
  // Disable the CSS transition for the first paint, so the page lands in
  // the right theme without visibly animating from the wrong one.
  root.setAttribute('data-theme-initial', 'pending');
  requestAnimationFrame(function () {
    root.removeAttribute('data-theme-initial');
  });
})();
