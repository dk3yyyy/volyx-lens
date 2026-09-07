'use strict';

const toggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('#site-nav');

function closeNavigation({ restoreFocus = false } = {}) {
  if (!toggle || !nav) return;
  nav.classList.remove('is-open');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open navigation');
  if (restoreFocus) toggle.focus();
}

if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    if (open) {
      closeNavigation();
    } else {
      nav.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close navigation');
      nav.querySelector('a')?.focus();
    }
  });

  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeNavigation();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      closeNavigation({ restoreFocus: true });
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 760) closeNavigation();
  });
}

const contextNames = {
  screen: 'Screen',
  you: 'microphone',
  them: 'system audio'
};

const contextControls = [...document.querySelectorAll('[data-context]')].filter((node) => node.matches('button'));
const summary = document.querySelector('[data-context-summary]');

function updateContext() {
  const active = contextControls.filter((button) => button.getAttribute('aria-pressed') === 'true');
  contextControls.forEach((button) => {
    const key = button.dataset.context;
    const isActive = button.getAttribute('aria-pressed') === 'true';
    button.classList.toggle('is-active', isActive);
    document.querySelector(`[data-beam="${key}"]`)?.classList.toggle('is-active', isActive);
    document.querySelector(`[data-label="${key}"]`)?.classList.toggle('is-active', isActive);
  });
  if (summary) {
    summary.textContent = active.length
      ? active.map((button) => contextNames[button.dataset.context]).join(' + ')
      : 'No context selected';
  }
}

contextControls.forEach((button) => {
  button.addEventListener('click', () => {
    const active = button.getAttribute('aria-pressed') === 'true';
    button.setAttribute('aria-pressed', String(!active));
    updateContext();
  });
});

updateContext();

document.querySelectorAll('details').forEach((details) => {
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    document.querySelectorAll('details[open]').forEach((other) => {
      if (other !== details) other.open = false;
    });
  });
});

const year = document.querySelector('[data-year]');
if (year) year.textContent = String(new Date().getFullYear());

// ---- theme toggle -------------------------------------------------------
const THEME_KEY = 'volyx-lens-theme';
const themeToggle = document.querySelector('[data-theme-toggle]');
const themeColorMeta = document.querySelector('meta[name="theme-color"]');

function applyTheme(theme, { persist = false } = {}) {
  const isLight = theme === 'light';
  document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
  if (themeColorMeta) {
    themeColorMeta.setAttribute('content', isLight ? '#f5f2ff' : '#0d0b1e');
  }
  if (themeToggle) {
    themeToggle.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
    themeToggle.setAttribute('aria-pressed', String(isLight));
  }
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, isLight ? 'light' : 'dark');
    } catch (error) {
      // storage may be unavailable; fall back to per-visit theme
    }
  }
}

function currentTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch (error) {
    // ignore storage failures
  }
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

applyTheme(currentTheme());

if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next, { persist: true });
  });
}

window.addEventListener('storage', (event) => {
  if (event.key === THEME_KEY && event.newValue) applyTheme(event.newValue);
});

const DL_ASSETS = {
  win: {
    href: 'https://github.com/dk3yyyy/volyx-lens/releases/download/v0.5.0/volyx-lens-0.5.0-win-x64.exe',
    label: 'Windows',
    detail: 'x64 NSIS installer · v0.5.0'
  },
  mac: {
    href: 'https://github.com/dk3yyyy/volyx-lens/releases/tag/adhoc-v0.3.1',
    label: 'macOS',
    detail: 'v0.3.1 test build · signed v0.5.0 pending'
  },
  'linux-x64': {
    href: 'https://github.com/dk3yyyy/volyx-lens/releases/download/v0.5.0/volyx-lens-0.5.0-linux-x86_64.AppImage',
    label: 'Linux x64',
    detail: 'AppImage · v0.5.0'
  },
  'linux-arm64': {
    href: 'https://github.com/dk3yyyy/volyx-lens/releases/download/v0.5.0/volyx-lens-0.5.0-linux-arm64.AppImage',
    label: 'Linux arm64',
    detail: 'AppImage · v0.5.0'
  }
};

function detectOS() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/windows|win32|win64/.test(ua)) return 'win';
  if (/mac os|macintosh/.test(ua)) return 'mac';
  if (/linux/.test(ua)) return /arm|aarch64/.test(ua) ? 'linux-arm64' : 'linux-x64';
  return null;
}

function initDownloads() {
  const detected = detectOS();
  const assets = DL_ASSETS[detected];
  const primary = document.querySelector('#dl-primary');
  const hero = document.querySelector('#dl-hero');
  const note = document.querySelector('#dl-note');

  if (detected && assets && (primary || hero)) {
    const label = `Download for ${assets.label}`;
    if (primary) {
      primary.href = assets.href;
      const span = primary.querySelector('span');
      if (span) span.textContent = label;
    }
    if (hero) {
      hero.href = assets.href;
      const span = hero.querySelector('span');
      if (span) span.textContent = label;
    }
    if (note) note.textContent = `Detected ${assets.label}: ${assets.detail}. Downloading starts from GitHub Releases; pick another platform below if needed.`;
    const card = document.querySelector(`.dl-card[data-os="${detected}"]`);
    if (card) {
      card.classList.add('is-recommended');
      card.setAttribute('aria-current', 'true');
    }
  } else if (note) {
    note.textContent = 'Choose your operating system below; every installer is served from GitHub Releases with a published SHA-256 checksum.';
  }
}

initDownloads();
