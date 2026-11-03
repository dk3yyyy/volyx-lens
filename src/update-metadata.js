'use strict';

// The file name electron-updater asks for on a given platform, mirroring
// Provider.getChannelFilePrefix() in the pinned electron-updater:
//
//   linux  -> "-linux", plus `-<arch>` for everything except x64
//   darwin -> "-mac"
//   win32  -> nothing
//
// This lives in its own module because the release workflow has to publish the
// name the client requests. It used to rename arm64 metadata to
// `latest-arm64-linux.yml`, which no client ever asked for: arm64 Linux builds
// requested `latest-arm64-linux-arm64.yml`, got a 404, and never updated while
// x64 worked, which hid the bug.

function channelFileFor({ platform, arch, channel = 'latest' } = {}) {
  const name = String(channel || 'latest');
  if (platform === 'linux') return `${name}-linux${arch === 'x64' ? '' : `-${arch}`}.yml`;
  if (platform === 'darwin') return `${name}-mac.yml`;
  return `${name}.yml`;
}

module.exports = { channelFileFor };
