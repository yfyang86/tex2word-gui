#!/bin/bash
#
# launcher.sh — the CFBundleExecutable of the standalone "Tex Word Studio"
# app bundle (copied to Contents/MacOS/TexWordStudio by build_dmg.sh).
#
# It starts the embedded uvicorn server on a free loopback port, waits until
# it answers /api/health, opens the default browser at the app, and stays in
# the foreground until the app is quit (Dock icon → Quit sends SIGTERM, which
# also stops the server). Launching the app again while a server is alive
# just opens a new browser tab on the running instance.
#
# All user data lives in ~/Library/Application Support/TexWordStudio:
#   tex2word.db          projects, chats, providers, jobs (SQLite)
#   tex2word_secret.key  master key for API keys stored in the DB
#   server.log           uvicorn + application log (rotated at ~10 MB)
#   server.state         "pid port" of the running server
#
set -u

RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
PY="$RES/python/bin/python3"
DATA="$HOME/Library/Application Support/TexWordStudio"
LOG="$DATA/server.log"
STATE="$DATA/server.state"
URL=""

[ -x "$PY" ] || { osascript -e 'display dialog "The bundled Python runtime is missing. Please re-download Tex Word Studio." with title "Tex Word Studio" buttons {"OK"} default button 1 with icon caution' >/dev/null 2>&1; exit 1; }
mkdir -p "$DATA"

# --- a server from an earlier launch still running? --------------------------
PORT=""
SRV=""
if [ -f "$STATE" ]; then
  read -r old_pid old_port < "$STATE" 2>/dev/null || true
  if [ -n "${old_pid:-}" ] && kill -0 "$old_pid" 2>/dev/null; then
    PORT="$old_port"
  fi
fi

fail_dialog() { # $1: hint shown in the dialog
  osascript -e "display dialog \"Tex Word Studio failed to start. $1 Log: $LOG\" with title \"Tex Word Studio\" buttons {\"Open Log\", \"OK\"} default button 2 with icon caution" >/dev/null 2>&1
  if [ "$?" = "0" ]; then open "$LOG" 2>/dev/null; fi
}

start_server() {
  PORT="$("$PY" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); p=s.getsockname()[1]; s.close(); print(p)')" || return 1

  # keep the log bounded
  if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    mv -f "$LOG" "$LOG.old"
  fi

  # cwd = the writable data dir, so CWD-relative files (secret key, default
  # DB name) land next to the user's data; TEX2WORD_DB pins the DB explicitly.
  cd "$DATA" || return 1
  export TEX2WORD_DB="$DATA/tex2word.db"
  export PYTHONPATH="$RES"
  export PYTHONPYCACHEPREFIX="$DATA/pycache"   # bundle dir may be read-only
  export PYTHONUNBUFFERED=1

  echo "--- $(date '+%Y-%m-%d %H:%M:%S') launching on port $PORT ---" >> "$LOG"
  "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --log-level warning >> "$LOG" 2>&1 &
  SRV=$!
  echo "$SRV $PORT" > "$STATE"

  # wait (up to ~90 s: first run imports a large dependency tree) for health
  local i waited=0
  for i in $(seq 1 180); do
    if ! kill -0 "$SRV" 2>/dev/null; then
      fail_dialog "The server process exited during startup."
      return 1
    fi
    if "$PY" - <<PYEOF >/dev/null 2>&1
import sys, urllib.request
sys.exit(0 if urllib.request.urlopen("http://127.0.0.1:$PORT/api/health", timeout=2).status == 200 else 1)
PYEOF
    then
      return 0
    fi
    sleep 0.5
  done
  fail_dialog "The server did not answer within 90 seconds."
  return 1
}

cleanup() {
  if [ -n "$SRV" ]; then
    kill "$SRV" 2>/dev/null
    wait "$SRV" 2>/dev/null
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "$PORT" ]; then
  start_server || exit 1
fi

open "http://127.0.0.1:$PORT/"

if [ -n "$SRV" ]; then
  # we own the server: stay alive until quit
  wait "$SRV"
else
  # reused an already-running server; nothing to keep alive
  exit 0
fi
