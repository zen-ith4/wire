#!/bin/bash
# Run ONLY the no-keyring session (D) with --password-store=basic.
#
# Safety: private HOME / XDG_RUNTIME_DIR / dbus session, deleted on exit.
# No keyring daemon is started. The app must refuse remember-me and must
# delete any unprotected v10 record it finds.
#
# Usage: e2e/run-no-keyring.sh

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"

TMP="$(mktemp -d /tmp/wire-e2e-nokeyring-XXXXXX)"
export HOME="$TMP/home"
export XDG_RUNTIME_DIR="$TMP/run"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
unset WAYLAND_DISPLAY DISPLAY

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

dbus-run-session -- bash -s "$HERE" <<'INNER'
set -u
HERE="$1"
echo "===== NO-KEYRING RUN (session D, --password-store=basic) ====="
E2E_PASSWORD_STORE=basic E2E_SESSIONS=D timeout -k 10 600 node "$HERE/run-e2e-test.js"
rc=$?
echo "===== NO-KEYRING RUN exit=$rc ====="
exit "$rc"
INNER

overall=$?
echo "===== ALL NO-KEYRING RUNS exit=$overall ====="
exit "$overall"
