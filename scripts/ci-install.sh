#!/usr/bin/env bash
# npm ci installs the Electron npm package, but Electron 45 downloads its
# native binary lazily on first use. That download comes from GitHub Releases
# and occasionally gets a 504 while the npm registry is healthy. Retry both
# npm ci and the Electron binary fetch instead of failing the job on a
# transient CDN error.
#
# After the first official attempt, use the npmmirror Electron mirror as a
# transport fallback. The Electron package still verifies the archive against
# its own bundled checksums.json, so the mirror is not trusted for integrity.
set -uo pipefail

attempts=3
electron_mirror="${ELECTRON_MIRROR_FALLBACK:-https://npmmirror.com/mirrors/electron/}"

for attempt in $(seq 1 "$attempts"); do
  echo "npm ci: attempt ${attempt}/${attempts}"
  if npm ci; then
    break
  else
    status=$?
    echo "npm ci failed with status ${status} (attempt ${attempt}/${attempts})"
    if [ "$attempt" -eq "$attempts" ]; then
      exit "$status"
    fi
    sleep $((attempt * 12))
  fi
done

for attempt in $(seq 1 "$attempts"); do
  # The first attempt stays on the official GitHub release server. Later
  # attempts use the mirror only after a transport failure.
  if [ "$attempt" -ge 2 ]; then
    export ELECTRON_MIRROR="$electron_mirror"
  fi
  echo "Electron binary: attempt ${attempt}/${attempts}"
  if node -e 'require("electron")'; then
    exit 0
  else
    status=$?
    echo "Electron binary download failed with status ${status} (attempt ${attempt}/${attempts})"
    if [ "$attempt" -eq "$attempts" ]; then
      exit "$status"
    fi
    # A failed lazy download can leave a partial dist behind. Clear it and the
    # path marker so the next attempt cannot mistake it for a completed install.
    rm -rf node_modules/electron/dist node_modules/electron/path.txt
    sleep $((attempt * 12))
  fi
done
