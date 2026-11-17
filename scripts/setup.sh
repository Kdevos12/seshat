#!/usr/bin/env bash
# One-command setup of Seshat on Linux or macOS (on Windows: inside WSL2). It does what
# documentation/install.md describes, step by step, and can be run again: each step that is already done
# is skipped. It never uses sudo: what needs it (bubblewrap) is printed for you to run.
#
#   scripts/setup.sh                 # everything a real run needs: Node packages, .env, Lean, base env, Kimina
#   scripts/setup.sh --no-lean       # only the Node side (the tests, the interface, the command line)
#   scripts/setup.sh --no-kimina     # everything but the Kimina Lean server
#   scripts/setup.sh --kimina-dir DIR
#
# The Lean part is long the first time: Mathlib's cache and formal-conjectures (30 to 60 minutes), then
# Kimina's own Lean projects; plan for about 15 GB of disk.
set -euo pipefail

LEAN_VERSION="v4.27.0"
# The Kimina commit Seshat has run with.
KIMINA_REPO="https://github.com/project-numina/kimina-lean-server.git"
KIMINA_REV="fb2393d"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_LEAN=1
WITH_KIMINA=1
KIMINA_DIR="${SESHAT_KIMINA_DIR:-$(dirname "$ROOT")/kimina-lean-server}"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-lean) WITH_LEAN=0; WITH_KIMINA=0 ;;
    --no-kimina) WITH_KIMINA=0 ;;
    --kimina-dir) KIMINA_DIR="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf '\n\033[31mSetup stopped:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

cd "$ROOT"

# 1. Node 22.19 or later -------------------------------------------------------------------------------
step "Node"
have node || fail "Node is not installed. Install Node 22.19 or later (https://nodejs.org, or nvm/fnm), then run this again."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || fail "Node $(node --version) is too old: Seshat needs 22.19 or later."
note "node $(node --version)"

# 2. pnpm 10, through corepack (package.json pins the version) ------------------------------------------
step "pnpm"
if ! have pnpm; then
  note "pnpm is missing: enabling it through corepack"
  corepack enable 2>/dev/null || corepack enable --install-directory "$HOME/.local/bin" \
    || fail "corepack could not enable pnpm. Run: npm install -g pnpm@10, then this again."
  export PATH="$HOME/.local/bin:$PATH"
fi
note "pnpm $(pnpm --version)"

# 3. The Node packages ---------------------------------------------------------------------------------
step "Node packages (pnpm install)"
pnpm install --frozen-lockfile

# 4. The .env file -------------------------------------------------------------------------------------
step "The .env file"
if [ ! -f .env ]; then
  cp .env.example .env
  secret="$(node -e 'console.log(require("node:crypto").randomBytes(18).toString("base64url"))')"
  sed -i.bak "s|^LEAN_SERVER_API_KEY=.*|LEAN_SERVER_API_KEY=$secret|" .env && rm -f .env.bak
  note "wrote .env from .env.example, with a fresh LEAN_SERVER_API_KEY"
else
  note ".env exists: left as it is"
fi
if grep -Eq '^DEEPSEEK_API=' .env && ! grep -Eq '^DEEPSEEK_API_KEY=.+' .env; then
  note "warning: .env sets DEEPSEEK_API; the key's variable is DEEPSEEK_API_KEY"
fi
grep -E '^[A-Z_]+_API_KEY=.+' .env | grep -v '^LEAN_SERVER_' | grep -q . || note "no model key yet: put your DEEPSEEK_API_KEY in .env (platform.deepseek.com)"

if [ "$WITH_LEAN" = 0 ]; then
  step "Done (Node side only)"
  note "pnpm harness --help      the command line"
  note "pnpm harness ui          the local interface"
  note "A real run also needs Lean: run scripts/setup.sh again without --no-lean."
  exit 0
fi

# 5. Lean through elan ---------------------------------------------------------------------------------
step "Lean $LEAN_VERSION through elan"
[ -f "$HOME/.elan/env" ] && . "$HOME/.elan/env"
if ! have elan; then
  have curl || fail "curl is needed to install elan."
  curl -sSf https://elan.lean-lang.org/elan-init.sh | sh -s -- -y --default-toolchain none
  . "$HOME/.elan/env"
fi
elan toolchain install "leanprover/lean4:$LEAN_VERSION"
note "$(elan --version)"

# 6. The Lean environment `base`: formal-conjectures and Mathlib, at the bench's pin -------------------
step "Lean environment base (formal-conjectures + Mathlib $LEAN_VERSION)"
state="$(pnpm -s harness lean-env show base 2>/dev/null | head -1 || true)"
case "$state" in
  *", built"*) note "already built" ;;
  *)
    case "$state" in "base: resolved"*) ;; *) pnpm -s harness lean-env resolve base ;; esac
    note "building: the first time takes 30 to 60 minutes"
    pnpm -s harness lean-env build base
    ;;
esac

# 7. The certifier's sandbox ---------------------------------------------------------------------------
step "Sandbox for the certifier"
if have bwrap; then
  note "bubblewrap found ($(command -v bwrap))"
elif have docker; then
  note "Docker found: doctor will try the Docker recipe (documentation/certifier.md#where-untrusted-code-runs)"
else
  note "no bubblewrap and no Docker: without a sandbox no claim can become proved."
  note "On Debian or Ubuntu: sudo apt install bubblewrap   (Fedora: sudo dnf install bubblewrap)"
fi

# 8. The Kimina Lean server ----------------------------------------------------------------------------
if [ "$WITH_KIMINA" = 1 ]; then
  step "Kimina Lean server in $KIMINA_DIR"
  have git || fail "git is needed for Kimina."
  have jq || fail "Kimina's setup needs jq (sudo apt install jq, or brew install jq)."
  have python3 || fail "Kimina needs Python 3.9 or later."
  if [ ! -d "$KIMINA_DIR/.git" ]; then
    git clone "$KIMINA_REPO" "$KIMINA_DIR"
    git -C "$KIMINA_DIR" checkout -q "$KIMINA_REV"
  fi
  if [ ! -d "$KIMINA_DIR/repl/.lake" ]; then
    (cd "$KIMINA_DIR" && LEAN_SERVER_LEAN_VERSION="$LEAN_VERSION" REPL_BRANCH="$LEAN_VERSION" bash setup.sh)
  else
    note "Kimina's Lean side is already built"
  fi
  if [ ! -x "$KIMINA_DIR/.venv/bin/python" ]; then
    python3 -m venv "$KIMINA_DIR/.venv"
    "$KIMINA_DIR/.venv/bin/pip" install -q -r "$KIMINA_DIR/requirements.txt"
    "$KIMINA_DIR/.venv/bin/pip" install -q "$KIMINA_DIR"
  fi
  note "start it with: scripts/kimina.sh   (in a terminal of its own)"
fi

# 9. What is still missing -----------------------------------------------------------------------------
step "pnpm harness doctor"
pnpm -s harness doctor || true

cat <<EOF

Next:
  1. Put your model key in .env (DEEPSEEK_API_KEY=...) if it is not there yet.
  2. In another terminal: scripts/kimina.sh
  3. pnpm harness doctor        # every line a run needs should be ok
  4. pnpm harness solve "(n : ℕ) : n + 0 = n" --max-usd 0.10
EOF
