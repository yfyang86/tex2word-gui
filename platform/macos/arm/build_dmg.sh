#!/usr/bin/env bash
#
# build_dmg.sh — build the standalone "Tex Word Studio" app bundle for
# macOS (Apple silicon) and wrap it in a distributable DMG.
#
# The bundle carries its own relocatable CPython runtime (from
# astral-sh/python-build-standalone) with every Python dependency
# pre-installed, plus a copy of the app/ package — target machines need no
# Python, uv or pip. Nothing outside platform/macos/arm is modified.
#
# Usage:
#   ./build_dmg.sh              # build the .app and the .dmg into ./dist
#   ./build_dmg.sh --app-only   # assemble the .app only (quick check)
#
# Environment:
#   https_proxy / http_proxy    passed through to curl and pip. Behind a local
#                               proxy use e.g.
#                               https_proxy=http://127.0.0.1:7897 ./build_dmg.sh
#   CODESIGN_IDENTITY           sign with a Developer ID Application
#                               certificate instead of an ad-hoc signature
#                               (real distribution: sign + notarize, see
#                               README.md).
#
set -euo pipefail

# --- pinned embedded runtime ---------------------------------------------------
# astral-sh/python-build-standalone release 20261021, CPython 3.12.15,
# macOS arm64, install_only flavor. Update deliberately: bump both the tag and
# the sha256 (from the release's SHA256SUMS asset).
PYTHON_BUILD_TAG="20261021"
PYTHON_VERSION="3.12.15"
PYTHON_ASSET="cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-aarch64-apple-darwin-install_only.tar.gz"
PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_TAG}/${PYTHON_ASSET//+/%2B}"
PYTHON_SHA256="a18cc33862b53bd54a148c710def5375c1b47470cccedf817a19c2d211764584"

# --- identity ------------------------------------------------------------------
APP_NAME="Tex Word Studio"
BUNDLE_ID="com.texwordstudio.desktop"
EXEC_NAME="TexWordStudio"

# --- layout --------------------------------------------------------------------
PLATFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$PLATFORM_DIR/../../.." && pwd)"
BUILD="$PLATFORM_DIR/build"
CACHE="$BUILD/cache"
DIST="$PLATFORM_DIR/dist"
APP_BUNDLE="$BUILD/$APP_NAME.app"
RES="$APP_BUNDLE/Contents/Resources"

APP_VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$ROOT/pyproject.toml" | head -1)"
[ -n "$APP_VERSION" ] || APP_VERSION="0.0.0"
DMG_PATH="$DIST/TexWordStudio-${APP_VERSION}-macos-arm64.dmg"

# Status messages go to stderr so $(…) captures of helper functions stay clean.
log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this build only runs on macOS"
[ "$(uname -m)" = "arm64" ] || die "this build only targets Apple silicon (run it on an arm64 Mac)"

# --- 1. fetch + verify the pinned runtime --------------------------------------
fetch_runtime() {
  mkdir -p "$CACHE"
  local tarball="$CACHE/$PYTHON_ASSET"
  if [ -f "$tarball" ] && [ "$(shasum -a 256 "$tarball" | cut -d' ' -f1)" != "$PYTHON_SHA256" ]; then
    rm -f "$tarball"    # stale cache (e.g. after a pin bump)
  fi
  if [ ! -f "$tarball" ]; then
    log "downloading CPython ${PYTHON_VERSION} (python-build-standalone ${PYTHON_BUILD_TAG})"
    curl -fL --retry 3 --connect-timeout 15 -o "$tarball" "$PYTHON_URL" \
      || die "download failed — behind a proxy? export https_proxy=http://… and retry"
    [ "$(shasum -a 256 "$tarball" | cut -d' ' -f1)" = "$PYTHON_SHA256" ] \
      || die "sha256 mismatch for $PYTHON_ASSET"
  fi
  echo "$tarball"
}

# --- 2. assemble the .app ------------------------------------------------------
assemble_app() {
  local tarball
  tarball="$(fetch_runtime)"

  log "staging $APP_NAME.app"
  rm -rf "$APP_BUNDLE"
  mkdir -p "$RES" "$APP_BUNDLE/Contents/MacOS"

  log "unpacking the Python runtime"
  tar -xzf "$tarball" -C "$RES"          # extracts as Resources/python/

  local pybin="$RES/python/bin/python3"
  [ -x "$pybin" ] || die "runtime unpacked without bin/python3"

  # pip is normally bundled; fall back to ensurepip, then get-pip.py.
  if ! "$pybin" -m pip --version >/dev/null 2>&1; then
    log "bootstrapping pip (ensurepip)"
    "$pybin" -m ensurepip --upgrade >/dev/null || {
      log "bootstrapping pip (get-pip.py)"
      curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$CACHE/get-pip.py"
      "$pybin" "$CACHE/get-pip.py" --no-warn-script-location >/dev/null
    }
  fi

  log "installing dependencies (from pyproject.toml, plus the 'pdf' extra)"
  "$pybin" - "$ROOT/pyproject.toml" > "$BUILD/requirements.txt" <<'EOF'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
deps = list(data["project"]["dependencies"])
deps += data["project"].get("optional-dependencies", {}).get("pdf", [])
print("\n".join(deps))
EOF
  "$pybin" -m pip install --no-input --prefer-binary --no-warn-script-location \
    -r "$BUILD/requirements.txt"

  log "copying the app package"
  rsync -a --exclude '__pycache__' --exclude '*.pyc' "$ROOT/app/" "$RES/app/"
  if [ ! -d "$RES/app/static/vendor/tikz-editor" ]; then
    echo "warning: app/static/vendor/tikz-editor is missing (build it with" \
         "scripts/build_tikz_editor.sh) — the visual TikZ editor will be disabled." >&2
  fi

  log "rendering the app icon (from the master icon.svg)"
  python3 "$ROOT/scripts/build_logo.py" --icns "$RES/AppIcon.icns"

  log "writing bundle metadata"
  sed -e "s/@APP_NAME@/$APP_NAME/g" -e "s/@BUNDLE_ID@/$BUNDLE_ID/g" \
      -e "s/@APP_VERSION@/$APP_VERSION/g" \
      "$PLATFORM_DIR/Info.plist" > "$APP_BUNDLE/Contents/Info.plist"
  install -m 755 "$PLATFORM_DIR/launcher.sh" "$APP_BUNDLE/Contents/MacOS/$EXEC_NAME"

  {
    echo "Tex Word Studio $APP_NAME bundle"
    echo "app version:   $APP_VERSION"
    echo "python:        $PYTHON_VERSION (python-build-standalone $PYTHON_BUILD_TAG)"
    echo "built:         $(date -u '+%Y-%m-%d %H:%M:%SZ')"
    echo "git commit:    $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo 'not a git checkout')"
    echo
    "$pybin" -m pip freeze
  } > "$RES/build-info.txt"

  log "smoke test: importing the app from the bundle"
  local smoke="$BUILD/smoke"
  rm -rf "$smoke" && mkdir -p "$smoke"
  ( cd "$smoke" && TEX2WORD_DB="$smoke/tex2word.db" PYTHONPATH="$RES" \
      "$pybin" -c "import app.main; print('import OK')" )
  rm -rf "$smoke"

  log "trimming caches from the runtime"
  find "$RES/python" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$RES/python/share/man" 2>/dev/null || true

  log "code-signing (${CODESIGN_IDENTITY:-ad-hoc})"
  codesign --force --deep --sign "${CODESIGN_IDENTITY:--}" "$APP_BUNDLE" >/dev/null 2>&1
  codesign --verify --strict "$APP_BUNDLE" || die "codesign verification failed"
}

# --- 3. wrap in a DMG ------------------------------------------------------------
make_dmg() {
  local dmgroot="$BUILD/dmgroot"
  log "creating $DMG_PATH"
  rm -rf "$dmgroot"
  mkdir -p "$dmgroot" "$DIST"
  cp -R "$APP_BUNDLE" "$dmgroot/"
  ln -s /Applications "$dmgroot/Applications"
  sed "s/@APP_VERSION@/$APP_VERSION/g" "$PLATFORM_DIR/dmg-readme.txt" > "$dmgroot/README.txt"
  hdiutil create -volname "$APP_NAME" -srcfolder "$dmgroot" -ov -format UDZO "$DMG_PATH" -quiet
  hdiutil verify "$DMG_PATH" -quiet
  log "sha256: $(shasum -a 256 "$DMG_PATH" | cut -d' ' -f1)"
}

case "${1:-}" in
  --app-only) assemble_app ;;
  ""|--dmg)   assemble_app; make_dmg ;;
  *) die "unknown option: $1 (use --app-only or nothing)" ;;
esac

log "done"
du -sh "$APP_BUNDLE" 2>/dev/null || true
[ -f "$DMG_PATH" ] && du -sh "$DMG_PATH" || true
exit 0
