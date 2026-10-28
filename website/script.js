'use strict';

const toggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('#site-nav');

function setMenuOpen(open) {
  if (!toggle || !nav) return;
  nav.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  document.body.style.overflow = open ? 'hidden' : '';
}

function closeNavigation({ restoreFocus = false } = {}) {
  setMenuOpen(false);
  if (restoreFocus) toggle.focus();
}

if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    setMenuOpen(!open);
    if (!open) nav.querySelector('a')?.focus();
  });

  nav.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    closeNavigation();
    if (!href.startsWith('#') || href.length < 2) return;
    const target = document.querySelector(href);
    if (!target) return;
    // Move focus to the section the link points at, so keyboard and screen
    // reader users land where the page scrolled instead of at <body>.
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });

  document.addEventListener('click', (event) => {
    if (toggle.getAttribute('aria-expanded') !== 'true') return;
    if (event.target.closest('#site-nav, .nav-toggle')) return;
    closeNavigation();
  });

  nav.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      const active = document.activeElement;
      if (!nav.contains(active) && active !== toggle) closeNavigation();
    });
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

// The theme is already set by the inline script in <head> to avoid a flash.
// Sync the toggle button state with it here, since the headless script can't
// see the button.
const initialTheme = currentTheme();
document.documentElement.setAttribute('data-theme', initialTheme === 'light' ? 'light' : 'dark');
if (themeColorMeta) {
  themeColorMeta.setAttribute('content', initialTheme === 'light' ? '#f5f2ff' : '#0d0b1e');
}
if (themeToggle) {
  themeToggle.setAttribute('aria-label', initialTheme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next, { persist: true });
  });
}

window.addEventListener('storage', (event) => {
  if (event.key === THEME_KEY && event.newValue) applyTheme(event.newValue);
});

const RELEASE = 'https://github.com/dk3yyyy/volyx-lens/releases';
const DL_ASSETS = {
  win: {
    href: `${RELEASE}/download/v0.7.4/volyx-lens-0.7.4-win-x64.exe`,
    label: 'Windows',
    detail: 'x64 NSIS installer · v0.7.4',
    direct: true
  },
  'mac-arm64': {
    href: `${RELEASE}/download/v0.7.4/volyx-lens-0.7.4-mac-arm64-unsigned.dmg`,
    label: 'macOS Apple Silicon',
    detail: 'Unsigned DMG · v0.7.4',
    direct: true
  },
  'mac-x64': {
    href: `${RELEASE}/download/v0.7.4/volyx-lens-0.7.4-mac-x64-unsigned.dmg`,
    label: 'macOS Intel',
    detail: 'Unsigned DMG · v0.7.4',
    direct: true
  },
  mac: {
    href: `${RELEASE}/tag/v0.7.4`,
    label: 'macOS',
    detail: 'Unsigned v0.7.4',
    direct: false
  },
  'linux-x64': {
    href: `${RELEASE}/download/v0.7.4/volyx-lens-0.7.4-linux-x86_64.AppImage`,
    label: 'Linux x64',
    detail: 'AppImage · v0.7.4',
    direct: true
  },
  'linux-arm64': {
    href: `${RELEASE}/download/v0.7.4/volyx-lens-0.7.4-linux-arm64.AppImage`,
    label: 'Linux arm64',
    detail: 'AppImage · v0.7.4',
    direct: true
  }
};

async function macArchitecture() {
  try {
    const data = navigator.userAgentData;
    if (!data || typeof data.getHighEntropyValues !== 'function') return null;
    const values = await data.getHighEntropyValues(['architecture']);
    if (values.architecture === 'arm') return 'mac-arm64';
    if (values.architecture === 'x86') return 'mac-x64';
  } catch (error) {
    // Client Hints can be unavailable or rejected; fall back to the release page.
  }
  return null;
}

async function detectOS() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/windows|win32|win64/.test(ua)) return 'win';
  if (/iphone|ipad|ipod|ios/.test(ua)) return null; // iOS UAs contain 'like Mac OS X'
  if (/mac os|macintosh/.test(ua)) return (await macArchitecture()) || 'mac';
  if (/android/.test(ua)) return null; // Android Chromium UAs contain 'linux'
  if (/linux/.test(ua)) return /arm|aarch64/.test(ua) ? 'linux-arm64' : 'linux-x64';
  return null;
}

async function initDownloads() {
  const detected = await detectOS();
  const assets = detected ? DL_ASSETS[detected] : null;
  const primary = document.querySelector('#dl-primary');
  const hero = document.querySelector('#dl-hero');
  const note = document.querySelector('#dl-note');

  if (!detected || !assets) {
    if (note) {
      note.textContent = 'Choose your operating system below; every build is served from GitHub Releases with its SHA-256 checksum attached.';
    }
    return;
  }

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
  if (note) {
    note.textContent = assets.direct
      ? `Detected ${assets.label}: ${assets.detail}. Downloading starts from GitHub Releases; pick another platform below if needed.`
      : `Detected ${assets.label}: ${assets.detail}. Pick Apple Silicon or Intel on the release page.`;
  }

  const card = document.querySelector(`.dl-card[data-os="${detected}"]`);
  if (!card) return;
  card.classList.add('is-recommended');
  card.setAttribute('aria-current', 'true');
  // The tag is injected so cards cannot drift out of sync with the markup.
  if (!card.querySelector('.dl-tag')) {
    const tag = document.createElement('i');
    tag.className = 'dl-tag';
    tag.textContent = 'Recommended for this device';
    card.appendChild(tag);
  }
}

initDownloads();
