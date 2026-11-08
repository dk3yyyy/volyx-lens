'use strict';

/* Navigation */
const navToggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('#site-nav');

function setMenu(open, { restoreFocus = false, focusFirst = false } = {}) {
  if (!navToggle || !nav) return;
  nav.dataset.open = String(open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  if (open && focusFirst) {
    const first = nav.querySelector('a');
    if (first) first.focus();
  }
  if (restoreFocus) navToggle.focus();
}

if (navToggle && nav) {
  navToggle.addEventListener('click', () => {
    setMenu(navToggle.getAttribute('aria-expanded') !== 'true', { focusFirst: true });
  });
  nav.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    setMenu(false);
    const target = document.querySelector(link.getAttribute('href'));
    if (target) {
      target.setAttribute('tabindex', '-1');
      window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (navToggle.getAttribute('aria-expanded') !== 'true') return;
    if (event.target.closest('#site-nav, .nav-toggle')) return;
    setMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') {
      setMenu(false, { restoreFocus: true });
    }
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 820) setMenu(false);
  });
}

/* Theme */
const THEME_KEY = 'volyx-lens-theme';
const themeToggle = document.querySelector('[data-theme-toggle]');
const themeColor = document.querySelector('meta[name="theme-color"]');

function applyTheme(theme, { persist = false } = {}) {
  const light = theme === 'light';
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  if (themeColor) themeColor.setAttribute('content', light ? '#efeee6' : '#0f1310');
  if (themeToggle) {
    themeToggle.setAttribute('aria-label', light ? 'Switch to dark mode (currently light)' : 'Switch to light mode (currently dark)');
  }
  if (persist) {
    try { localStorage.setItem(THEME_KEY, light ? 'light' : 'dark'); } catch (error) { /* storage unavailable */ }
  }
}

function savedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch (error) { /* storage unavailable */ }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

applyTheme(savedTheme());
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light', { persist: true });
  });
}

window.addEventListener('storage', (event) => {
  if (event.key === THEME_KEY && (event.newValue === 'light' || event.newValue === 'dark')) applyTheme(event.newValue);
});

const systemTheme = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
if (systemTheme && typeof systemTheme.addEventListener === 'function') {
  systemTheme.addEventListener('change', () => {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (error) { /* storage unavailable */ }
    if (saved !== 'light' && saved !== 'dark') applyTheme(systemTheme.matches ? 'dark' : 'light');
  });
}

/* The hero composer is a preview, not a live request */
const previewForm = document.querySelector('.composer');
const previewStatus = document.querySelector('.preview-status');
if (previewForm && previewStatus) {
  previewForm.addEventListener('submit', (event) => {
    event.preventDefault();
    previewStatus.textContent = 'Preview only. Install Volyx Lens to ask real questions.';
    window.clearTimeout(previewStatus._timer);
    previewStatus._timer = window.setTimeout(() => { previewStatus.textContent = ''; }, 5000);
  });
}

/* OS-aware download buttons */
const RELEASE = 'https://github.com/dk3yyyy/volyx-lens/releases';
const ASSETS = {
  win: { href: `${RELEASE}/download/v0.8.4/volyx-lens-0.8.4-win-x64.exe`, label: 'Windows', detail: 'x64 installer' },
  'mac-arm64': { href: `${RELEASE}/download/v0.8.4/volyx-lens-0.8.4-mac-arm64-unsigned.dmg`, label: 'macOS Apple Silicon', detail: 'Unsigned DMG' },
  'mac-x64': { href: `${RELEASE}/download/v0.8.4/volyx-lens-0.8.4-mac-x64-unsigned.dmg`, label: 'macOS Intel', detail: 'Unsigned DMG' },
  mac: { href: `${RELEASE}/tag/v0.8.4`, label: 'macOS', detail: 'Choose Intel or Apple Silicon' },
  'linux-x64': { href: `${RELEASE}/download/v0.8.4/volyx-lens-0.8.4-linux-x86_64.AppImage`, label: 'Linux x64', detail: 'AppImage' },
  'linux-arm64': { href: `${RELEASE}/download/v0.8.4/volyx-lens-0.8.4-linux-arm64.AppImage`, label: 'Linux arm64', detail: 'AppImage' }
};

// Safari and Firefox do not expose Client Hints. Their WebGL renderer string
// still tells Apple silicon from Intel, so the button can point at one DMG
// instead of dumping the visitor on the release page.
function macArchFromRenderer() {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    if (/apple/i.test(renderer)) return 'mac-arm64';
    if (/intel|amd|radeon/i.test(renderer)) return 'mac-x64';
  } catch (error) { /* WebGL unavailable */ }
  return null;
}

async function macArch() {
  try {
    const data = navigator.userAgentData;
    if (data && typeof data.getHighEntropyValues === 'function') {
      const values = await data.getHighEntropyValues(['architecture']);
      if (values.architecture === 'arm') return 'mac-arm64';
      if (values.architecture === 'x86') return 'mac-x64';
    }
  } catch (error) { /* client hints unavailable */ }
  return macArchFromRenderer();
}

async function detectOS() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/windows|win32|win64/.test(ua)) return 'win';
  if (/iphone|ipad|ipod|ios|android|cros/.test(ua)) return null;
  if (/mac os|macintosh/.test(ua)) {
    if ((navigator.maxTouchPoints || 0) > 1 || /mobile/.test(ua)) return null;
    return (await macArch()) || 'mac';
  }
  if (/android/.test(ua)) return null;
  if (/linux/.test(ua)) return /arm|aarch64/.test(ua) ? 'linux-arm64' : 'linux-x64';
  return null;
}

async function initDownloads() {
  const os = await detectOS();
  const asset = os ? ASSETS[os] : null;
  if (!asset) {
    document.querySelectorAll('[data-detected]').forEach((note) => { note.hidden = true; });
    return;
  }
  document.querySelectorAll('[data-download]').forEach((link) => {
    link.href = asset.href;
    // The label stays universal; the detected platform is secondary metadata.
    link.setAttribute('aria-label', `Download Volyx Lens for ${asset.label}`);
  });
  document.querySelectorAll('[data-detected]').forEach((note) => {
    note.textContent = `Detected ${asset.label} · ${asset.detail} · v0.8.4`;
    note.hidden = false;
  });
  const key = document.querySelector('.composer-key');
  if (key) key.textContent = os.startsWith('mac') ? '⌘↵' : 'Ctrl↵';
}

initDownloads();

/* One-line install */
const INSTALL_COMMANDS = {
  unix: 'curl -fsSL https://volyxlens.pages.dev/install.sh | sh',
  windows: 'irm https://volyxlens.pages.dev/install.ps1 | iex'
};
function setInstallPlatform(platform) {
  const command = document.querySelector('[data-install-command]');
  if (!command || !INSTALL_COMMANDS[platform]) return;
  command.textContent = INSTALL_COMMANDS[platform];
  document.querySelectorAll('[data-install-platform]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.installPlatform === platform));
  });
}
document.querySelectorAll('[data-install-platform]').forEach((button) => {
  button.addEventListener('click', () => setInstallPlatform(button.dataset.installPlatform));
});
if (/windows/i.test(navigator.userAgent || '')) setInstallPlatform('windows');
const copyCommand = document.querySelector('[data-copy-command]');
if (copyCommand) {
  copyCommand.addEventListener('click', async () => {
    const command = document.querySelector('[data-install-command]');
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command.textContent);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(command);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('copy');
      selection.removeAllRanges();
    }
    copyCommand.textContent = 'Copied';
    copyCommand.classList.add('is-copied');
    setTimeout(() => {
      copyCommand.textContent = 'Copy';
      copyCommand.classList.remove('is-copied');
    }, 1600);
  });
}

/* Year */
const year = document.querySelector('[data-year]');
if (year) year.textContent = String(new Date().getFullYear());
