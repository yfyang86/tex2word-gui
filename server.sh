#!/usr/bin/env bash
#
# server.sh — manage the Tex Word Studio (FastAPI) server.
#
#   ./server.sh --start      start the server (background)
#   ./server.sh --stop       stop the server
#   ./server.sh --status     show whether the server is running
#   ./server.sh --restart    stop then start
#
# Host/port come from config.toml ([backend]); override with env vars:
#   TEX2WORD_HOST=127.0.0.1 TEX2WORD_PORT=9000 ./server.sh --start
#
set -uo pipefail

# --- locations ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/.server.pid"
LOG_FILE="$SCRIPT_DIR/server.log"
APP="app.main:app"

# --- pick a Python/uvicorn runner -------------------------------------------
if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
  PY="$SCRIPT_DIR/.venv/bin/python"
  RUN=("$PY" -m uvicorn)
elif command -v uv >/dev/null 2>&1; then
  PY="uv run python"
  RUN=(uv run uvicorn)
else
  PY="python3"
  RUN=(python3 -m uvicorn)
fi

# --- resolve host/port (env > config.toml > defaults) ------------------------
read_config() {
  # Print "HOST PORT" using the app's own config loader; silent on failure.
  $PY - <<'PYEOF' 2>/dev/null
try:
    from app.config import get_config
    c = get_config()
    print(c.backend.host, c.backend.port)
except Exception:
    pass
PYEOF
}

CFG="$(read_config)"
CFG_HOST="${CFG%% *}"
CFG_PORT="${CFG##* }"
HOST="${TEX2WORD_HOST:-${CFG_HOST:-0.0.0.0}}"
PORT="${TEX2WORD_PORT:-${CFG_PORT:-8000}}"

# --- helpers -----------------------------------------------------------------
is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

current_pid() { cat "$PID_FILE" 2>/dev/null; }

start() {
  if is_running; then
    echo "already running (pid $(current_pid)) on http://$HOST:$PORT"
    return 0
  fi
  rm -f "$PID_FILE"
  echo "starting on http://$HOST:$PORT (logs: $LOG_FILE)"
  nohup "${RUN[@]}" "$APP" --host "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"

  # give uvicorn a moment to bind, then confirm it's still alive
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "failed to start — last log lines:"
      tail -n 20 "$LOG_FILE" 2>/dev/null
      rm -f "$PID_FILE"
      return 1
    fi
  done
  echo "started (pid $pid)"
}

stop() {
  if ! is_running; then
    echo "not running"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(current_pid)"
  echo "stopping (pid $pid)"
  kill "$pid" 2>/dev/null
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "did not exit gracefully — sending SIGKILL"
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  echo "stopped"
}

status() {
  if is_running; then
    echo "running (pid $(current_pid)) on http://$HOST:$PORT"
    return 0
  fi
  echo "stopped"
  return 1
}

usage() {
  cat <<EOF
Usage: ${0##*/} [--start|--stop|--status|--restart]

  --start     start the server in the background
  --stop      stop the server
  --status    report whether the server is running
  --restart   stop then start

Host/port: env TEX2WORD_HOST / TEX2WORD_PORT override config.toml [backend].
Current target: http://$HOST:$PORT
EOF
}

# --- dispatch (accept "--start" and "start") --------------------------------
case "${1:-}" in
  --start|start)     start ;;
  --stop|stop)       stop ;;
  --status|status)   status ;;
  --restart|restart) stop; start ;;
  -h|--help|help|"") usage ;;
  *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
esac
