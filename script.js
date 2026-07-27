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
