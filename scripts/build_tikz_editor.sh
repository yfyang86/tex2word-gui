#!/usr/bin/env bash
# Build the embedded TikZ editor (https://github.com/DominikPeters/tikz-editor,
# MIT) into app/static/vendor/tikz-editor/.
#
# The bundle is ~50 MB (mostly lazily loaded font outlines), so it is built,
# not committed. The app works without it; the TikZ editor tool then explains
# how to install it.
#
# Usage: scripts/build_tikz_editor.sh
# Env:   TIKZ_EDITOR_REF   upstream commit to build (default: the pinned one)
#        TIKZ_EDITOR_SRC   checkout directory (default: .cache/tikz-editor)
#        TIKZ_EDITOR_OUT   output directory  (default: app/static/vendor/tikz-editor)
# Needs: git, Node.js >= 20 with npm.
set -euo pipefail

UPSTREAM="https://github.com/DominikPeters/tikz-editor"
PINNED_REF="8591fab1f53a02b4fcb8e5d7d4df191e681317fc" # 0.6.0, 2026-10-20
REF="${TIKZ_EDITOR_REF:-$PINNED_REF}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${TIKZ_EDITOR_SRC:-$ROOT/.cache/tikz-editor}"
OUT="${TIKZ_EDITOR_OUT:-$ROOT/app/static/vendor/tikz-editor}"
SHELL_DIR="$ROOT/tools/tikz-editor-embed"

log() { printf '\033[1m[tikz-editor]\033[0m %s\n' "$*"; }

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "Node.js (npm) is required" >&2; exit 1; }

# ── 1. upstream checkout at REF (shallow, reused between runs)
if [ ! -d "$SRC/.git" ]; then
  log "cloning $UPSTREAM"
  mkdir -p "$SRC"
  git -C "$SRC" init -q
  git -C "$SRC" remote add origin "$UPSTREAM"
fi
if [ "$(git -C "$SRC" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$REF" ]; then
  log "fetching $REF"
  git -C "$SRC" fetch -q --depth 1 origin "$REF"
  git -C "$SRC" checkout -q --force FETCH_HEAD
fi
# start from a pristine tree, then apply our fixes (tools/tikz-editor-embed/patches)
git -C "$SRC" reset -q --hard
for patch in "$SHELL_DIR"/patches/*.patch; do
  [ -e "$patch" ] || continue
  log "applying $(basename "$patch")"
  git -C "$SRC" apply "$patch"
done
VERSION="$(node -p "require('$SRC/package.json').version")"

# ── 2. dependencies + generated sources (grammars, example previews)
log "installing dependencies (tikz-editor $VERSION)"
(cd "$SRC" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
(cd "$SRC" && npm run --silent generate:grammar >/dev/null)
(cd "$SRC" && npm run --silent -w @tikz-editor/web generate:example-previews >/dev/null)

# ── 3. our embed shell as apps/embed, built with a relative base
rm -rf "$SRC/apps/embed"
mkdir -p "$SRC/apps/embed"
cp -R "$SHELL_DIR/index.html" "$SHELL_DIR/vite.config.ts" "$SHELL_DIR/tsconfig.json" "$SHELL_DIR/src" "$SRC/apps/embed/"
log "building into $OUT"
rm -rf "$OUT"
(cd "$SRC/apps/embed" && TIKZ_EDITOR_VERSION="$VERSION" npx --no-install vite build \
  --logLevel warn --outDir "$OUT" --emptyOutDir)

# ── 4. licence + provenance next to the bundle
cp "$SRC/LICENSE" "$OUT/LICENSE"
cat > "$OUT/BUILD.json" <<JSON
{
  "name": "tikz-editor",
  "version": "$VERSION",
  "upstream": "$UPSTREAM",
  "ref": "$REF",
  "license": "MIT",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
log "done: $(du -sh "$OUT" | cut -f1) in $OUT"
