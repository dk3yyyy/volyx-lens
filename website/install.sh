#!/bin/sh
# Volyx Lens installer for macOS and Linux.
#
#   curl -fsSL https://volyxlens.pages.dev/install.sh | sh
#
# It resolves the newest GitHub release, downloads the asset for this OS and
# architecture, verifies the published SHA-256, and installs:
#   macOS  -> /Applications (or ~/Applications with --user)
#   Linux  -> ~/.local/bin/volyx-lens.AppImage plus a desktop entry
#
# Flags:
#   --version vX.Y.Z   install a specific release instead of the latest
#   --user             macOS only: install into ~/Applications
#   --prefix DIR       install the app into DIR (macOS)
#   --no-launch        do not open the app after installing
#   --dry-run          print what would happen, download nothing
set -eu

REPO="dk3yyyy/volyx-lens"
SITE="https://volyxlens.pages.dev"
VERSION=""
PREFIX=""
USER_INSTALL=0
LAUNCH=1
DRY_RUN=0

usage() {
  cat <<'EOF'
Volyx Lens installer for macOS and Linux.

  curl -fsSL https://volyxlens.pages.dev/install.sh | sh

It resolves the newest GitHub release, downloads the asset for this OS and
architecture, verifies the published SHA-256, and installs:
  macOS  -> /Applications (or ~/Applications with --user)
  Linux  -> ~/.local/bin/volyx-lens.AppImage plus a desktop entry

Flags:
  --version vX.Y.Z   install a specific release instead of the latest
  --user             macOS only: install into ~/Applications
  --prefix DIR       install the app into DIR (macOS)
  --no-launch        do not open the app after installing
  --dry-run          print what would happen, download nothing
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --user) USER_INSTALL=1; shift ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    --no-launch) LAUNCH=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "volyx-lens: $*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "requires $1"
}

need curl
need uname
if command -v shasum >/dev/null 2>&1; then
  CHECKSUM="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM="sha256sum"
else
  die "requires shasum or sha256sum"
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64) SUFFIX="mac-arm64-unsigned.dmg" ;;
      x86_64) SUFFIX="mac-x64-unsigned.dmg" ;;
      *) die "unsupported Mac architecture: $ARCH" ;;
    esac
    need hdiutil
    need ditto
    ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64) SUFFIX="linux-x86_64.AppImage" ;;
      aarch64|arm64) SUFFIX="linux-arm64.AppImage" ;;
      *) die "unsupported Linux architecture: $ARCH" ;;
    esac
    ;;
  *)
    die "this installer supports macOS and Linux; on Windows run install.ps1"
    ;;
esac

if [ -z "$VERSION" ]; then
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
  if [ -n "$RELEASE_JSON" ]; then
    VERSION="$(printf '%s\n' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  fi
  if [ -z "$VERSION" ]; then
    # The API is rate-limited per IP; the release redirect is not.
    VERSION="$(curl -fsSI "https://github.com/$REPO/releases/latest" 2>/dev/null \
      | tr -d '\r' \
      | sed -n 's|^[Ll]ocation: .*/tag/\([^ ]*\)$|\1|p' \
      | head -1 || true)"
  fi
  [ -n "$VERSION" ] || die "could not determine the latest version"
fi
case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
NUMBER="${VERSION#v}"

ASSET="volyx-lens-${NUMBER}-${SUFFIX}"
BASE="https://github.com/$REPO/releases/download/$VERSION"
URL="$BASE/$ASSET"
SHA_URL="$URL.sha256"

if [ "$DRY_RUN" = 1 ]; then
  echo "Would install Volyx Lens $VERSION for $OS $ARCH"
  echo "  asset: $ASSET"
  echo "  from:  $URL"
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/volyx-lens.XXXXXX")"
MOUNT=""
cleanup() {
  [ -n "$MOUNT" ] && hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

echo "Downloading Volyx Lens $VERSION for $OS $ARCH..."
curl -fL --retry 3 --progress-bar "$URL" -o "$TMP/$ASSET" \
  || die "download failed: $URL"
curl -fsSL --retry 3 "$SHA_URL" -o "$TMP/$ASSET.sha256" \
  || die "checksum file missing: $SHA_URL.sha256"

echo "Verifying SHA-256..."
( cd "$TMP" && $CHECKSUM -c "$ASSET.sha256" ) || die "checksum did not match"

if [ "$OS" = "Darwin" ]; then
  if [ -n "$PREFIX" ]; then
    DEST="$PREFIX"
  elif [ "$USER_INSTALL" = 1 ]; then
    DEST="$HOME/Applications"
  else
    DEST="/Applications"
  fi
  mkdir -p "$DEST" 2>/dev/null || true
  if [ ! -w "$DEST" ]; then
    need sudo
    SUDO="sudo"
  else
    SUDO=""
  fi

  if pgrep -f "Volyx Lens.app/Contents/MacOS/Volyx Lens" >/dev/null 2>&1; then
    echo "Quitting the running Volyx Lens..."
    osascript -e 'tell application "Volyx Lens" to quit' >/dev/null 2>&1 || true
    sleep 2
  fi

  MOUNT="$TMP/mnt"
  mkdir -p "$MOUNT"
  hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$TMP/$ASSET" >/dev/null \
    || die "could not mount the DMG"

  [ -d "$MOUNT/Volyx Lens.app" ] || die "the DMG does not contain Volyx Lens.app"
  echo "Installing to $DEST/Volyx Lens.app..."
  $SUDO rm -rf "$DEST/Volyx Lens.app"
  $SUDO ditto "$MOUNT/Volyx Lens.app" "$DEST/Volyx Lens.app"
  # The published DMG is unsigned; clearing quarantine is what makes the
  # first launch work without the right-click dance.
  $SUDO xattr -cr "$DEST/Volyx Lens.app" 2>/dev/null || true

  hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
  MOUNT=""

  if [ "$LAUNCH" = 1 ]; then
    open "$DEST/Volyx Lens.app" >/dev/null 2>&1 || true
  fi
  echo "Installed Volyx Lens $VERSION in $DEST."
  echo "If macOS still blocks it, right-click the app and choose Open once."
else
  BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
  mkdir -p "$BIN_DIR"
  TARGET="$BIN_DIR/volyx-lens.AppImage"
  install -m 755 "$TMP/$ASSET" "$TARGET"
  echo "Installed $TARGET"

  ICON_DIR="$HOME/.local/share/icons"
  APP_DIR="$HOME/.local/share/applications"
  mkdir -p "$ICON_DIR" "$APP_DIR"
  if curl -fsSL "$SITE/assets/volyx-lens-logo.svg" -o "$ICON_DIR/volyx-lens.svg" 2>/dev/null; then
    ICON="$ICON_DIR/volyx-lens.svg"
  else
    ICON="utilities-terminal"
  fi
  cat > "$APP_DIR/volyx-lens.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Volyx Lens
Comment=Private desktop AI panel
Exec=$TARGET
Icon=$ICON
Terminal=false
Categories=Utility;
EOF
  echo "Added a desktop entry: $APP_DIR/volyx-lens.desktop"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "Add $BIN_DIR to PATH to run 'volyx-lens.AppImage' from a shell." ;;
  esac
  if [ "$LAUNCH" = 1 ]; then
    "$TARGET" >/dev/null 2>&1 &
  fi
  echo "Installed Volyx Lens $VERSION."
fi
