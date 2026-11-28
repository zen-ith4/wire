#!/bin/bash
# Run the real-Electron Phase 2 E2E suite under a THROWAWAY gnome-keyring.
#
# Safety: this script never touches the user's real keyring, HOME, userData,
# database, uploads or .env. It creates a private HOME, a private
# XDG_RUNTIME_DIR, a private dbus session and a private unlocked keyring,
# then deletes all of it on exit.
#
# Usage:
#   e2e/run-with-keyring.sh            # 3 full runs (default)
#   e2e/run-with-keyring.sh 1          # one run
#
# Every run executes sessions A,B,C,D. A/B/C use --password-store=gnome-libsecret;
# D always uses --password-store=basic to prove the no-keyring refusal.

set -u

RUNS="${1:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"

TMP="$(mktemp -d /tmp/wire-e2e-keyring-XXXXXX)"
export HOME="$TMP/home"
export XDG_RUNTIME_DIR="$TMP/run"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export E2E_KEYRING_PASSWORD="wire-e2e-throwaway-keyring"
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
unset WAYLAND_DISPLAY DISPLAY

cleanup() {
  # Kill only the keyring daemon that belongs to THIS runtime dir. Never use
  # a bare pkill: the user's real keyring daemon may be running.
  pkill -f "gnome-keyring-daemon.*$XDG_RUNTIME_DIR" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

dbus-run-session -- bash -s "$HERE" "$RUNS" <<'INNER'
set -u
HERE="$1"
RUNS="$2"

printf '%s' "$E2E_KEYRING_PASSWORD" | gnome-keyring-daemon --unlock --components=secrets
echo "[keyring] throwaway keyring unlocked (HOME=$HOME, runtime=$XDG_RUNTIME_DIR)"

for i in $(seq 1 "$RUNS"); do
  echo ""
  echo "===== KEYRING RUN $i/$RUNS ====="
  E2E_PASSWORD_STORE=gnome-libsecret E2E_SESSIONS=A,B,C,D \
    timeout -k 10 1200 node "$HERE/run-e2e-test.js"
  rc=$?
  echo "===== KEYRING RUN $i/$RUNS exit=$rc ====="
  if [ "$rc" -ne 0 ]; then
    exit "$rc"
  fi
done
exit 0
INNER

overall=$?
echo ""
echo "===== ALL KEYRING RUNS exit=$overall ====="
exit "$overall"
