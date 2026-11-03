'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { updateNotificationPolicy, deferredNoticeKey } = require('../src/notification-policy');

const notice = { kind: 'available', version: '0.7.6', title: 'Volyx Lens update available' };

test('nothing is shown when there is no notice', () => {
  for (const missing of [undefined, null, 'available', 42, false]) {
    assert.deepEqual(updateNotificationPolicy({ notice: missing }), { show: false, silent: false, defer: false });
  }
  assert.deepEqual(updateNotificationPolicy(), { show: false, silent: false, defer: false });
});

test('an unsupported platform neither shows nor retries', () => {
  // Waiting cannot make the OS able to show it, so the notice is dropped.
  assert.deepEqual(
    updateNotificationPolicy({ notice, notificationsSupported: false }),
    { show: false, silent: false, defer: false },
  );
});

test('a locked screen defers the notice until unlock', () => {
  assert.deepEqual(
    updateNotificationPolicy({ notice, locked: true }),
    { show: false, silent: false, defer: true },
  );
});

test('a live capture suppresses the notice without deferring it', () => {
  // The banner would cut into a call; by the time it is over the news is stale.
  assert.deepEqual(
    updateNotificationPolicy({ notice, capturing: true }),
    { show: false, silent: false, defer: false },
  );
});

test('a focused window suppresses the notice without deferring it', () => {
  // The user is already looking at the Updates pane, so a banner is redundant.
  assert.deepEqual(
    updateNotificationPolicy({ notice, focused: true }),
    { show: false, silent: false, defer: false },
  );
});

test('a quiet moment shows the notice silently', () => {
  assert.deepEqual(updateNotificationPolicy({ notice }), { show: true, silent: true, defer: false });
  // Explicit false flags are the same as the defaults.
  assert.deepEqual(
    updateNotificationPolicy({ notice, notificationsSupported: true, focused: false, capturing: false, locked: false }),
    { show: true, silent: true, defer: false },
  );
});

test('the displayed banner is always silent, including on the ready path', () => {
  const ready = { kind: 'ready', version: '0.7.6' };
  const decision = updateNotificationPolicy({ notice: ready });
  assert.equal(decision.show, true);
  assert.equal(decision.silent, true);
});

test('locked outranks capturing and focused', () => {
  // Deferring is what preserves the notice for later; a busy user must not cost
  // the announcement outright.
  assert.deepEqual(
    updateNotificationPolicy({ notice, locked: true, capturing: true, focused: true }),
    { show: false, silent: false, defer: true },
  );
});

test('capturing outranks focused, and either suppresses the banner', () => {
  assert.deepEqual(
    updateNotificationPolicy({ notice, capturing: true, focused: true }),
    { show: false, silent: false, defer: false },
  );
});

test('unsupported outranks locked, capturing, and focused', () => {
  assert.deepEqual(
    updateNotificationPolicy({ notice, notificationsSupported: false, locked: true, capturing: true, focused: true }),
    { show: false, silent: false, defer: false },
  );
});

test('a missing notice outranks every other flag', () => {
  assert.deepEqual(
    updateNotificationPolicy({ notice: null, notificationsSupported: false, locked: true, capturing: true, focused: true }),
    { show: false, silent: false, defer: false },
  );
});

test('the deferred key is stable across equal notices and repeat calls', () => {
  const first = deferredNoticeKey(notice);
  const second = deferredNoticeKey({ ...notice });
  assert.equal(first, 'available:0.7.6');
  assert.equal(first, second);
  assert.equal(deferredNoticeKey(notice), first);
});

test('the deferred key distinguishes versions and kinds', () => {
  assert.notEqual(deferredNoticeKey(notice), deferredNoticeKey({ ...notice, version: '0.7.7' }));
  assert.notEqual(deferredNoticeKey(notice), deferredNoticeKey({ ...notice, kind: 'ready' }));
  assert.equal(deferredNoticeKey({ kind: 'ready', version: '0.7.6' }), 'ready:0.7.6');
});

test('the deferred key stays well formed when fields are missing', () => {
  assert.equal(deferredNoticeKey({}), 'update:unknown');
  assert.equal(deferredNoticeKey({ kind: 'available' }), 'available:unknown');
  assert.equal(deferredNoticeKey({ version: '0.7.6' }), 'update:0.7.6');
  assert.equal(deferredNoticeKey({ kind: '  ', version: '  ' }), 'update:unknown');
  assert.equal(deferredNoticeKey({ kind: 'available', version: 0.7 }), 'available:0.7');
  // A non-object cannot name a notice, but it still yields a usable key.
  assert.equal(deferredNoticeKey(null), 'update:unknown');
  assert.equal(deferredNoticeKey('available'), 'update:unknown');
});
