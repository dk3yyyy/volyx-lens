'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { channelFileFor } = require('../src/update-metadata');
const { releaseChannel } = require('../src/update-manager');

const root = path.join(__dirname, '..');

test('the Linux metadata name matches what electron-updater requests', () => {
  // Provider.getChannelFilePrefix() appends "-linux" on x64 and
  // "-linux-<arch>" everywhere else. The release used to rename arm64 metadata
  // to latest-arm64-linux.yml, so arm64 clients asked for a missing file.
  assert.equal(channelFileFor({ platform: 'linux', arch: 'x64', channel: releaseChannel('linux', 'x64') }), 'latest-x64-linux.yml');
  assert.equal(channelFileFor({ platform: 'linux', arch: 'arm64', channel: releaseChannel('linux', 'arm64') }), 'latest-arm64-linux-arm64.yml');
});

test('macOS and Windows names are unchanged by the fix', () => {
  assert.equal(channelFileFor({ platform: 'darwin', arch: 'arm64', channel: releaseChannel('darwin', 'arm64') }), 'latest-arm64-mac.yml');
  assert.equal(channelFileFor({ platform: 'darwin', arch: 'x64', channel: releaseChannel('darwin', 'x64') }), 'latest-x64-mac.yml');
  assert.equal(channelFileFor({ platform: 'win32', arch: 'x64', channel: releaseChannel('win32', 'x64') }), 'latest.yml');
});

test('the Linux release workflow publishes the name the client asks for', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-linux.yml'), 'utf8');
  // The step must derive the name from the shared rule instead of hard-coding a
  // template that disagrees with electron-updater.
  assert.match(workflow, /src\/update-metadata/, 'the workflow uses the shared naming rule');
  assert.doesNotMatch(workflow, /EXPECTED_META="latest-\$\{ARCH\}-linux\.yml"/, 'the old hard-coded arm64 name is gone');
});
