#!/usr/bin/env bash
# Real-world smoke test against an installed, authenticated `agy`.
# Makes 4 real model calls plus the setup auth probe. Uses gemini-3.8-flash-low to save quota.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPANION="$ROOT/plugins/gemini/scripts/gemini-companion.mjs"
MODEL="${GEMINI_SMOKE_MODEL:-gemini-3.8-flash-low}"

# agy mishandles symlinked paths (/var, /tmp on macOS), so the temp repo lives under $HOME.
mkdir -p "$HOME/.cache"
REPO="$(mktemp -d "$HOME/.cache/gemini-bridge-smoke.XXXX")"
DATA="$(mktemp -d "$HOME/.cache/gemini-bridge-smoke-data.XXXX")"
cleanup() { rm -rf "$REPO" "$DATA"; }
trap cleanup EXIT

export CLAUDE_PLUGIN_DATA="$DATA"
export GEMINI_BRIDGE_SESSION_ID="smoke-session"

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

run_json() { # name, args...
  local name="$1"; shift
  OUT="$(cd "$REPO" && node "$COMPANION" "$@" 2>"$DATA/stderr.txt")"
  local code=$?
  echo "--- $name (exit $code) ---"; echo "$OUT" | head -c 600; echo
  OK="$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).ok===true)}catch{console.log(false)}})')"
  if [ "$OK" = "true" ]; then pass "$name"; else fail "$name"; head -c 800 "$DATA/stderr.txt"; fi
}

cd "$REPO" || exit 1
git init -q && git config user.email smoke@example.com && git config user.name smoke
cat > calc.js <<'JS'
// Returns the sum of two numbers.
function add(a, b) {
  return a + b;
}
module.exports = { add };
JS
git add calc.js && git commit -q -m "init"
# Uncommitted change that introduces the bug, so the review has something real to find.
sed -i.bak 's/return a + b;/return a - b;/' calc.js && rm -f calc.js.bak
cp calc.js "$DATA/calc.before.js"

run_json "setup" setup --json
run_json "review" review --wait --json --model "$MODEL"
run_json "task" task --json --model "$MODEL" "Fix the bug in calc.js so add returns the sum of a and b. Edit the file; do not run any commands."

if ! diff -q "$REPO/calc.js" "$DATA/calc.before.js" >/dev/null; then pass "calc.js was modified by task"; else fail "calc.js was not modified"; fi

run_json "task --resume-last" task --resume-last --json --model "$MODEL" "What did you change in calc.js? Answer in one sentence."

echo
if [ "$FAILS" -eq 0 ]; then echo "SMOKE: all checks passed (agy $(agy --version 2>/dev/null || ~/.local/bin/agy --version 2>/dev/null))"; else echo "SMOKE: $FAILS check(s) failed"; exit 1; fi
