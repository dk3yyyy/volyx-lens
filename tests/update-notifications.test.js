'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { updateNotificationFor, notificationsEnabled, notificationKey } = require('../src/update-notifications');

function state(status, extra = {}) {
  return { supported: true, status, availableVersion: null, currentVersion: '0.7.4', progress: null, message: '', ...extra };
}

test('an update that becomes available raises one notification naming the version', () => {
  const notice = updateNotificationFor({
    previous: state('checking'),
    next: state('available', { availableVersion: '0.7.5' }),
  });
  assert.equal(notice.kind, 'available');
  assert.equal(notice.version, '0.7.5');
  assert.match(notice.body, /0\.7\.5/);
  assert.match(notice.title, /available/i);
});

test('the same version is not announced twice when a periodic check finds it again', () => {
  // A six-hourly check walks checking -> available every cycle. The edge fires
  // each time; the key is what keeps it to one announcement per version.
  const first = updateNotificationFor({ previous: state('checking'), next: state('available', { availableVersion: '0.7.5' }) });
  const second = updateNotificationFor({ previous: state('checking'), next: state('available', { availableVersion: '0.7.5' }) });
  assert.equal(first.key, second.key);
  assert.notEqual(first.key, notificationKey('available', '0.7.6'));
});

test('a finished download raises the ready-to-install notification', () => {
  const notice = updateNotificationFor({
    previous: state('downloading', { availableVersion: '0.7.5' }),
    next: state('downloaded', { availableVersion: '0.7.5' }),
  });
  assert.equal(notice.kind, 'ready');
  assert.match(notice.body, /restart/i);
});

test('nothing is raised for states that are not a new update', () => {
  for (const [previous, next] of [
    [state('idle'), state('checking')],
    [state('checking'), state('current')],
    [state('available'), state('available')],
    [state('downloading'), state('downloading')],
    [state('checking'), state('error')],
  ]) {
    assert.equal(updateNotificationFor({ previous, next }), null, `${previous.status} -> ${next.status}`);
  }
});

test('a build that cannot install updates never notifies', () => {
  const unsupported = { ...state('available', { availableVersion: '0.7.5' }), supported: false };
  assert.equal(updateNotificationFor({ previous: state('idle'), next: unsupported }), null);
});

test('turning the setting off silences both notifications', () => {
  assert.equal(updateNotificationFor({ previous: state('checking'), next: state('available', { availableVersion: '0.7.5' }), enabled: false }), null);
  assert.equal(updateNotificationFor({ previous: state('downloading'), next: state('downloaded'), enabled: false }), null);
});

test('notifications are on unless the stored preference says otherwise', () => {
  assert.equal(notificationsEnabled({}), true);
  assert.equal(notificationsEnabled({ notifications: {} }), true);
  assert.equal(notificationsEnabled({ notifications: { updates: true } }), true);
  assert.equal(notificationsEnabled({ notifications: { updates: false } }), false);
  assert.equal(notificationsEnabled(null), true);
});
