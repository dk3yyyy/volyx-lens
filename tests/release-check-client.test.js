'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReleaseChecker } = require('../src/release-check-client');
const pkg = require('../package.json');

const RELEASE_URL = 'https://github.com/dk3yyyy/volyx-lens/releases/tag/v0.7.6';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('a successful payload returns the parsed version and release URL', async () => {
  const calls = [];
  const checker = createReleaseChecker({
    userAgent: 'Volyx-Lens/test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ tag_name: 'v0.7.6', html_url: RELEASE_URL });
    },
  });

  assert.deepEqual(await checker.latest(), { version: '0.7.6', url: RELEASE_URL });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/dk3yyyy/volyx-lens/releases/latest');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].options.headers['User-Agent'], 'Volyx-Lens/test');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('repo and default User-Agent are configurable/derived from package.json', async () => {
  let captured;
  const checker = createReleaseChecker({
    repo: 'owner/other-repo',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse({ tag_name: '0.7.6', html_url: RELEASE_URL });
    },
  });

  await checker.latest();
  assert.equal(captured.url, 'https://api.github.com/repos/owner/other-repo/releases/latest');
  assert.equal(captured.options.headers['User-Agent'], `Volyx-Lens/${pkg.version}`);
});

test('404 resolves to null because no release has been published yet', async () => {
  const checker = createReleaseChecker({
    fetchImpl: async () => jsonResponse({ message: 'Not Found' }, 404),
  });

  assert.equal(await checker.latest(), null);
});

test('other non-2xx responses throw an error that includes the status', async () => {
  const checker = createReleaseChecker({
    fetchImpl: async () => jsonResponse({ message: 'boom' }, 500),
  });

  await assert.rejects(checker.latest(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /500/);
    return true;
  });
});

test('a request that outlives the timeout throws, aborts, and clears its timer', async () => {
  const cleared = [];
  let seenSignal = null;
  let timers = 0;

  const checker = createReleaseChecker({
    timeoutMs: 25,
    setTimer: (callback) => {
      timers += 1;
      const id = `timer-${timers}`;
      // Fire on the next tick: the fetch has been started by then.
      setImmediate(callback);
      return id;
    },
    clearTimer: (id) => {
      cleared.push(id);
    },
    fetchImpl: (url, options) => {
      seenSignal = options.signal;
      return new Promise(() => {});
    },
  });

  await assert.rejects(checker.latest(), /timed out/i);
  assert.equal(seenSignal.aborted, true);
  assert.deepEqual(cleared, ['timer-1']);
});

test('a network rejection is propagated', async () => {
  const checker = createReleaseChecker({
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    },
  });

  await assert.rejects(checker.latest(), /ENOTFOUND/);
});

test('malformed JSON throws without echoing the body', async () => {
  const checker = createReleaseChecker({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0: <html>secret-body</html>');
      },
    }),
  });

  await assert.rejects(checker.latest(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /valid JSON/i);
    assert.doesNotMatch(error.message, /secret-body|Unexpected token/);
    return true;
  });
});

test('a JSON body that is not an object throws', async () => {
  const checker = createReleaseChecker({
    fetchImpl: async () => jsonResponse(['not', 'an', 'object']),
  });

  await assert.rejects(checker.latest(), /JSON object/i);
});

test('a non-string tag_name throws', async () => {
  const checker = createReleaseChecker({
    fetchImpl: async () => jsonResponse({ tag_name: 123, html_url: RELEASE_URL }),
  });

  await assert.rejects(checker.latest(), /tag_name/);
});

test('an unparsable tag resolves to null instead of throwing', async () => {
  const checker = createReleaseChecker({
    fetchImpl: async () => jsonResponse({ tag_name: 'nightly', html_url: RELEASE_URL }),
  });

  assert.equal(await checker.latest(), null);
});

test('a non-GitHub html_url is dropped', async () => {
  const checker = createReleaseChecker({
    fetchImpl: async () => jsonResponse({ tag_name: 'v0.7.6', html_url: 'https://evil.example/x' }),
  });

  assert.deepEqual(await checker.latest(), { version: '0.7.6', url: null });
});
