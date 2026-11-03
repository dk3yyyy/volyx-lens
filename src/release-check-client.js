'use strict';

const { parseReleaseVersion } = require('./release-check');

const DEFAULT_REPO = 'dk3yyyy/volyx-lens';
const DEFAULT_TIMEOUT_MS = 8000;

function defaultUserAgent() {
  let version = '0.0.0';
  try {
    const pkg = require('../package.json');
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) version = pkg.version.trim();
  } catch {
    // package.json should always be present; fall back to a harmless default.
  }
  return `Volyx-Lens/${version}`;
}

function defaultFetch(url, options) {
  // Required lazily so requiring this module in plain Node never touches Electron.
  return require('electron').net.fetch(url, options);
}

function createReleaseChecker({
  repo = DEFAULT_REPO,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  userAgent,
  // Injected so the timeout path can be tested without real waiting.
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const repository = typeof repo === 'string' && repo.trim() ? repo.trim() : DEFAULT_REPO;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const agent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : defaultUserAgent();
  const url = `https://api.github.com/repos/${repository}/releases/latest`;

  async function latest() {
    const request = typeof fetchImpl === 'function' ? fetchImpl : defaultFetch;
    const controller = new AbortController();

    let timer;
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = setTimer(() => {
        controller.abort();
        reject(new Error(`Release check timed out after ${timeout}ms`));
      }, timeout);
    });

    let response;
    try {
      // Promise.resolve().then(...) turns a synchronous fetchImpl throw into a
      // rejection so the timer is always cleared by the finally block.
      const fetchPromise = Promise.resolve().then(() => request(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': agent,
        },
        signal: controller.signal,
      }));
      // Racing also guarantees the timeout surfaces even if an injected fetch
      // implementation ignores the abort signal.
      response = await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      clearTimer(timer);
    }

    if (!response || typeof response !== 'object') {
      throw new Error('Release check failed: empty response');
    }

    const status = Number(response.status);
    if (status === 404) return null;

    const ok = response.ok === true || (Number.isFinite(status) && status >= 200 && status < 300);
    if (!ok) {
      throw new Error(`Release check failed with status ${Number.isFinite(status) ? status : 'unknown'}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      // Do not echo the body: a JSON parse error can quote response contents.
      throw new Error('Release check failed: response was not valid JSON');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Release check failed: response was not a JSON object');
    }
    if (typeof payload.tag_name !== 'string') {
      throw new Error('Release check failed: release tag_name is missing');
    }

    const version = parseReleaseVersion(payload.tag_name);
    if (!version) return null;

    // Defense in depth, matching releaseUpdateFrom: never surface a non-GitHub
    // URL that could later reach shell.openExternal.
    const htmlUrl = typeof payload.html_url === 'string' &&
      payload.html_url.startsWith('https://github.com/')
      ? payload.html_url
      : null;

    return { version, url: htmlUrl };
  }

  return { latest };
}

module.exports = { createReleaseChecker };
