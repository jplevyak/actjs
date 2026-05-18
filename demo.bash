#!/usr/bin/env bash
#
# actjs demo script.
#
# Walks through the framework's HTTP API:
#   * /run     — execute a snippet of JS inside a transaction
#   * /upload  — upload one or more class source files
#
# Prerequisites:
#   * Redis running locally (or set REDIS_URL when starting the server)
#   * The actjs server running: `npm start` (or `PORT=3000 node main.js`)
#
# Environment variables (all optional):
#   ACTJS_URL   Server base URL.   Default: http://127.0.0.1:3000
#   AUTO        If "1", do not pause between steps. Default: 0
#
# Usage:
#   ./demo.bash           # interactive walk-through
#   AUTO=1 ./demo.bash    # run end-to-end without prompts

set -euo pipefail

ACTJS_URL="${ACTJS_URL:-http://127.0.0.1:3000}"
AUTO="${AUTO:-0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Use jq for pretty-printing if available, otherwise pass JSON through unchanged.
if command -v jq >/dev/null 2>&1; then
  pretty() { jq .; }
else
  pretty() { cat; }
fi

# ---- Output helpers ---------------------------------------------------------

if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; CYAN=$'\e[36m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else
  BOLD=""; DIM=""; CYAN=""; YELLOW=""; RESET=""
fi

step_n=0
step() {
  step_n=$((step_n + 1))
  printf '\n%s== Step %d: %s ==%s\n' "$BOLD$CYAN" "$step_n" "$1" "$RESET"
}

note() { printf '%s%s%s\n' "$DIM" "$1" "$RESET"; }

show_cmd() { printf '%s$ %s%s\n' "$YELLOW" "$*" "$RESET"; }

pause() {
  [[ "$AUTO" == "1" ]] && return 0
  printf '\n'
  read -r -p "Press [Enter] to continue (Ctrl-C to abort)..." _
}

# Show, then execute, a command — sending its stdout through the pretty filter.
run_curl() {
  show_cmd curl "$@"
  curl --silent --show-error --fail-with-body "$@" | pretty
  printf '\n'
}

show_file() {
  show_cmd cat "$1"
  printf '%s\n' "----"
  cat "$HERE/$1"
  printf '%s\n' "----"
}

# ---- Preflight --------------------------------------------------------------

note "actjs demo against $ACTJS_URL"
if ! curl --silent --show-error --fail "$ACTJS_URL/" >/dev/null; then
  printf '%sERROR%s: cannot reach actjs at %s. Start it with `npm start` first.\n' \
    $'\e[31m' "$RESET" "$ACTJS_URL" >&2
  exit 1
fi
note "server is up."

# ---- Demo steps -------------------------------------------------------------

step "Run a trivial snippet"
note "POST plain text JS to /run; the body is wrapped in an async function."
run_curl -X POST -H "Content-Type: text/plain" --data "return 1;" "$ACTJS_URL/run"
pause

step "Create two linked Actors"
show_file demo1_create
run_curl -X POST -H "Content-Type: text/plain" --data-binary "@$HERE/demo1_create" "$ACTJS_URL/run"
pause

step "Read a property through a lazy Actor reference"
show_file demo1_read
run_curl -X POST -H "Content-Type: text/plain" --data-binary "@$HERE/demo1_read" "$ACTJS_URL/run"
pause

step "Write a property and observe the new value in-transaction"
show_file demo1_write
run_curl -X POST -H "Content-Type: text/plain" --data-binary "@$HERE/demo1_write" "$ACTJS_URL/run"
pause

step "Read again — the write committed"
show_file demo1_read
run_curl -X POST -H "Content-Type: text/plain" --data-binary "@$HERE/demo1_read" "$ACTJS_URL/run"
pause

step "Upload a user-defined Actor class (Beta)"
show_file Beta.js
run_curl -X POST -F "file=@$HERE/Beta.js" "$ACTJS_URL/upload"
pause

step "Instantiate Beta and store it"
show_file demo2_create
run_curl -X POST -H "Content-Type: text/plain" --data-binary "@$HERE/demo2_create" "$ACTJS_URL/run"
pause

step "Load Beta and call its method"
show_file demo2_read
run_curl -X POST -H "Content-Type: text/plain" --data-binary "@$HERE/demo2_read" "$ACTJS_URL/run"
pause

step "Upload Beta and a Replica class (Gamma) together"
show_file Gamma.js
run_curl -X POST \
  -F "file1=@$HERE/Beta.js" \
  -F "file2=@$HERE/Gamma.js" \
  "$ACTJS_URL/upload"
pause

step "Create a Gamma replica"
show_file demo3_create
run_curl -X POST -H "Content-Type: text/plain" --data-binary "@$HERE/demo3_create" "$ACTJS_URL/run"
pause

step "Mutate a Replica in-transaction (writes are not persisted by default)"
show_file demo3_read
run_curl -X POST -H "Content-Type: text/plain" --data-binary "@$HERE/demo3_read" "$ACTJS_URL/run"
pause

step "Re-run — Replica state is unchanged across transactions"
show_file demo3_read
run_curl -X POST -H "Content-Type: text/plain" --data-binary "@$HERE/demo3_read" "$ACTJS_URL/run"

printf '\n%sDemo complete.%s\n' "$BOLD" "$RESET"
