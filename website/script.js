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
  if (themeColor) themeColor.setAttribute('content', light ? '#eceee7' : '#101411');
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

/* Context switches in the interface preview */
const sources = [...document.querySelectorAll('[data-source]')];
const contextCount = document.querySelector('[data-context-count]');


function updateContext() {
  const active = sources.filter((button) => button.getAttribute('aria-pressed') === 'true');
  sources.forEach((button) => {
    const on = button.getAttribute('aria-pressed') === 'true';
    button.classList.toggle('is-on', on);
    const small = button.querySelector('small');
    if (small) {
      const key = button.dataset.source;
      const base = key === 'screen' ? 'Display 1' : key === 'mic' ? 'Built-in' : 'System';
      small.textContent = `${base} · ${on ? 'On' : 'Off'}`;
    }
  });
  if (contextCount) contextCount.textContent = `${active.length} of 3 sources`;
}

sources.forEach((button) => {
  button.addEventListener('click', () => {
    button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    updateContext();
  });
});
updateContext();

/* Provider menu in the interface preview */
const providerButton = document.querySelector('.app-provider');
const providerMenu = document.querySelector('#provider-menu');
const providerLabels = document.querySelectorAll('[data-provider-label], [data-provider]');

function setProviderMenu(open) {
  if (!providerButton || !providerMenu) return;
  providerMenu.hidden = !open;
  providerButton.setAttribute('aria-expanded', String(open));
}

if (providerButton && providerMenu) {
  providerButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setProviderMenu(providerMenu.hidden);
  });
  providerMenu.addEventListener('click', (event) => {
    const option = event.target.closest('[data-provider-option]');
    if (!option) return;
    const value = option.dataset.providerOption;
    providerLabels.forEach((label) => { label.textContent = value; });
    providerMenu.querySelectorAll('[data-provider-option]').forEach((item) => {
      item.setAttribute('aria-pressed', String(item === option));
    });
    setProviderMenu(false);
    providerButton.focus();
  });
  document.addEventListener('click', (event) => {
    if (!providerMenu.hidden && !event.target.closest('.app-provider, #provider-menu')) setProviderMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !providerMenu.hidden) {
      setProviderMenu(false);
      providerButton.focus();
    }
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
  win: { href: `${RELEASE}/download/v0.8.0/volyx-lens-0.8.0-win-x64.exe`, label: 'Windows', detail: 'x64 installer' },
  'mac-arm64': { href: `${RELEASE}/download/v0.8.0/volyx-lens-0.8.0-mac-arm64-unsigned.dmg`, label: 'macOS Apple Silicon', detail: 'Unsigned DMG' },
  'mac-x64': { href: `${RELEASE}/download/v0.8.0/volyx-lens-0.8.0-mac-x64-unsigned.dmg`, label: 'macOS Intel', detail: 'Unsigned DMG' },
  mac: { href: `${RELEASE}/download/v0.8.0/volyx-lens-0.8.0-mac-arm64-unsigned.dmg`, label: 'macOS', detail: 'Apple silicon · unsigned DMG' },
  'linux-x64': { href: `${RELEASE}/download/v0.8.0/volyx-lens-0.8.0-linux-x86_64.AppImage`, label: 'Linux x64', detail: 'AppImage' },
  'linux-arm64': { href: `${RELEASE}/download/v0.8.0/volyx-lens-0.8.0-linux-arm64.AppImage`, label: 'Linux arm64', detail: 'AppImage' }
};

async function macArch() {
  try {
    const data = navigator.userAgentData;
    if (!data || typeof data.getHighEntropyValues !== 'function') return null;
    const values = await data.getHighEntropyValues(['architecture']);
    if (values.architecture === 'arm') return 'mac-arm64';
    if (values.architecture === 'x86') return 'mac-x64';
  } catch (error) { /* client hints unavailable */ }
  return null;
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
    const label = link.querySelector('span');
    if (label) label.textContent = `Download for ${asset.label}`;
  });
  document.querySelectorAll('[data-detected]').forEach((note) => {
    note.textContent = `Detected ${asset.label} · ${asset.detail} · v0.8.0`;
    note.hidden = false;
  });
  const key = document.querySelector('.composer-key');
  if (key) key.textContent = os.startsWith('mac') ? '⌘↵' : 'Ctrl↵';
}

initDownloads();

/* Year */
const year = document.querySelector('[data-year]');
if (year) year.textContent = String(new Date().getFullYear());
