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
