#!/usr/bin/env bash
# Starts the Kimina Lean server that `harness solve` checks proofs with, on this machine only
# (127.0.0.1), with the project `lean/env/base` and memory settings that fit the machine
# (documentation/install.md#3-the-kimina-lean-server). Keep it running in a terminal of its own.
#
# Every setting can be overridden from the environment or from .env: LEAN_SERVER_MAX_REPLS,
# LEAN_SERVER_MAX_REPL_USES, LEAN_SERVER_MAX_REPL_MEM, LEAN_SERVER_PORT, SESHAT_KIMINA_DIR.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
KIMINA_DIR="${SESHAT_KIMINA_DIR:-$(dirname "$ROOT")/kimina-lean-server}"
[ -d "$KIMINA_DIR" ] || { echo "No Kimina in $KIMINA_DIR: run scripts/setup.sh first (or set SESHAT_KIMINA_DIR)." >&2; exit 1; }
[ -f "$HOME/.elan/env" ] && . "$HOME/.elan/env"

PROJECT="${LEAN_SERVER_PROJECT_DIR:-$ROOT/lean/env/base}"
[ -d "$PROJECT" ] || { echo "No Lean project at $PROJECT: run pnpm harness lean-env build base first." >&2; exit 1; }
[ -n "${LEAN_SERVER_API_KEY:-}" ] || { echo "LEAN_SERVER_API_KEY is empty: set it in .env (any secret; Seshat sends the same)." >&2; exit 1; }

# Memory: as harness doctor advises, one REPL per 4 GB of 60% of the memory, recycled every 50 uses
# (100 above 32 GB). MAX_REPL_MEM is a limit on virtual memory: below about 12G Lean does not start
# (seen on a 13 GB machine), so 12G is the floor here.
total_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$total_mb" = 0 ] && command -v sysctl >/dev/null; then total_mb=$(( $(sysctl -n hw.memsize) / 1048576 )); fi
repls=$(( total_mb * 6 / 10 / 4096 )); [ "$repls" -lt 1 ] && repls=1; [ "$repls" -gt 32 ] && repls=32
uses=50; [ "$total_mb" -ge 32768 ] && uses=100

export LEAN_SERVER_HOST="${LEAN_SERVER_HOST:-127.0.0.1}"
export LEAN_SERVER_PORT="${LEAN_SERVER_PORT:-8000}"
export LEAN_SERVER_PROJECT_DIR="$PROJECT"
export LEAN_SERVER_API_KEY
export LEAN_SERVER_LEAN_VERSION="${LEAN_SERVER_LEAN_VERSION:-v4.27.0}"
export LEAN_SERVER_MAX_REPLS="${LEAN_SERVER_MAX_REPLS:-$repls}"
export LEAN_SERVER_MAX_REPL_USES="${LEAN_SERVER_MAX_REPL_USES:-$uses}"
export LEAN_SERVER_MAX_REPL_MEM="${LEAN_SERVER_MAX_REPL_MEM:-12G}"

echo "Kimina on http://$LEAN_SERVER_HOST:$LEAN_SERVER_PORT, project $LEAN_SERVER_PROJECT_DIR"
echo "REPLs $LEAN_SERVER_MAX_REPLS, recycled every $LEAN_SERVER_MAX_REPL_USES uses, $LEAN_SERVER_MAX_REPL_MEM each"
cd "$KIMINA_DIR"
PY="$KIMINA_DIR/.venv/bin/python"; [ -x "$PY" ] || PY=python3
exec "$PY" -m server
