# macOS (Apple silicon) standalone build

Builds **Tex Word Studio** as a self-contained `.app` for macOS 13+ on
Apple silicon, wrapped in a DMG that other people can use with **no Python,
uv or pip installed** — the bundle carries its own CPython runtime with every
dependency pre-installed, plus a copy of the `app/` package.

Only files under `platform/macos/arm/` are involved; the rest of the
repository is never modified. Build outputs land in `build/` and `dist/`
here, which the top-level `.gitignore` already excludes.

## Build

Run on an arm64 Mac (the DMG is not universal — it targets `aarch64`):

```bash
platform/macos/arm/build_dmg.sh              # → dist/TexWordStudio-<ver>-macos-arm64.dmg
platform/macos/arm/build_dmg.sh --app-only   # just assemble build/Tex Word Studio.app
```

Requirements on the build machine: `curl`, `git`, Xcode or Command Line
Tools (for `codesign`/`iconutil`/`sips`), ~1.5 GB of free disk, and network
access to GitHub (runtime tarball) and PyPI (wheels).

Behind a proxy, export the standard variables first — both `curl` and `pip`
honour them:

```bash
export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
```

The embedded runtime is **pinned** (`PYTHON_VERSION` / `PYTHON_BUILD_TAG` /
`PYTHON_SHA256` at the top of `build_dmg.sh`, from
[astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone));
the tarball is cached under `build/cache/`. Python dependencies are read
from the project `pyproject.toml` (runtime deps + the `pdf` extra), so the
bundle tracks the project's own pins. `Contents/Resources/build-info.txt`
inside the app records the exact `pip freeze`, the runtime tag and the git
commit it was built from.

Note: the visual TikZ editor bundle (`app/static/vendor/tikz-editor/`, built
by `scripts/build_tikz_editor.sh`, not committed) is included when present;
otherwise the build warns and the TikZ editor dialog is simply disabled.

## What the bundle does at runtime

`Contents/MacOS/TexWordStudio` (from `launcher.sh`) starts uvicorn on a
random free port on `127.0.0.1` using the bundled interpreter, waits for
`/api/health`, opens the default browser, and stays in the foreground —
quitting from the Dock stops the server. Launching again while it runs just
opens a new tab.

All user data lives in `~/Library/Application Support/TexWordStudio/`
(`tex2word.db`, `tex2word_secret.key`, `server.log`); the bundle itself is
read-only after installation. The app runs with its default configuration —
LLM providers are added inside the app (keys encrypted at rest), exactly as
the project README describes.

## Distributing

The build signs ad-hoc by default, which is fine for your own machines. A
DMG you send to others is *not* notarized, so recipients see Gatekeeper
warnings on first launch: they must confirm via **System Settings → Privacy
& Security → "Open Anyway"** (this is spelled out in the DMG's `README.txt`).

For a clean distribution experience, sign with a real Developer ID and
notarize the DMG:

```bash
export CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
platform/macos/arm/build_dmg.sh
xcrun notarytool submit dist/TexWordStudio-<ver>-macos-arm64.dmg \
    --keychain-profile notarytool --wait
xcrun stapler staple dist/TexWordStudio-<ver>-macos-arm64.dmg
```

## Files here

| File | Purpose |
|------|---------|
| `build_dmg.sh` | the whole pipeline: fetch runtime → install deps → assemble `.app` → icon → sign → DMG |
| `launcher.sh` | becomes `Contents/MacOS/TexWordStudio`; starts the server and opens the browser |
| `Info.plist` | bundle metadata template (`@APP_NAME@`, `@BUNDLE_ID@`, `@APP_VERSION@` placeholders) |
| `dmg-readme.txt` | short end-user notes shipped inside the DMG |

The app icon is **not** kept here: the master artwork is `icon.svg` at the
repository root, and the bundle's `AppIcon.icns` is generated from it by
`scripts/build_logo.py --icns` (invoked by `build_dmg.sh`). Change the logo by
editing that one file and re-running `scripts/build_logo.py`, which refreshes
every derived artifact — the web favicons, the distribution PNGs in `assets/`
and the macOS icon — so they can never drift apart.
