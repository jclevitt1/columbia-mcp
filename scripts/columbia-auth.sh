#!/usr/bin/env bash
#
# Run every interactive re-authentication the bridge needs, in one pass.
#
# Both steps open a real browser window and expect a human at the keyboard, so
# this has to run at the Mini itself — there is no remote equivalent. Duo
# approval is deliberately manual; the whole point of a second factor is that
# a person approves it.
#
# A failing step does not abort the run: if Google auth fails you still want
# the chance to fix Vergil in the same sitting.

set -uo pipefail

ROOT="${COLUMBIA_MCP_ROOT:-$HOME/columbia-mcp}"
cd "$ROOT" || { echo "columbia-auth: no checkout at $ROOT" >&2; exit 1; }

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail_list=()

# The bridge and the login script share one Chromium profile, and a persistent
# context can only be held by a single process. If the bridge has a browser
# open, vergil-login dies on the profile lock — so say so before wasting a Duo
# tap on it.
if pgrep -f "columbia-mcp.*[Cc]hromium|browser-profile" >/dev/null 2>&1; then
  echo
  echo "WARNING: something is already using the browser profile."
  echo "         If vergil-login fails on a profile lock, run 'cbot-restart' and retry."
fi

run_step() {
  local label="$1" script="$2"
  echo
  bold "==> $label"
  if npm run --silent "$script"; then
    echo "--- $label: ok"
  else
    echo "--- $label: FAILED" >&2
    fail_list+=("$label")
  fi
}

bold "Columbia auth — re-authenticating everything"
echo "Checkout: $ROOT"

run_step "Google OAuth (Gmail, Drive, Docs, Sheets, Calendar)" gmail-auth
run_step "Columbia CAS (Vergil + SSOL)" vergil-login

echo
if [ ${#fail_list[@]} -eq 0 ]; then
  bold "All auth steps completed."
else
  bold "Completed with failures: ${fail_list[*]}"
fi
echo "Check the result with:  npm run doctor    (or: columbia-sweep)"

[ ${#fail_list[@]} -eq 0 ]
