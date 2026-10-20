#!/usr/bin/env bash
# STEP 3E item 4: run the group attachment browser tests on LINUX with the
# project's own Chromium (@sparticuz/chromium).
#
# The owner has Windows only, so this script and the recipe in
# docs/RUN_BROWSER_TESTS_LINUX.md are **UNVERIFIED** here: nothing in this
# repository was executed on Linux. Treat the first run as a debugging
# session, not as a green light.
#
# What it does: it copies the tree into a writable place inside the
# container (the bind mount is READ-ONLY, so `npm ci` cannot touch the
# Windows tree), installs the browser packages the harness resolves through
# CHROMIUM_DIR, and runs the browser test file. It exits non-zero when the
# tests fail.
#
# Usage:
#   scripts/run-browser-tests-linux.sh                 # the group attachment tests
#   scripts/run-browser-tests-linux.sh <test-file> ... # other browser test files
#
# Requirements: Docker with a Linux daemon. On Windows that means Docker
# Desktop with the WSL2 backend (or a Linux host).

set -euo pipefail

TREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-node:22-bookworm}"
WORK="${WORK:-wire-browser-tests}"
CHROMIUM_DIR="${CHROMIUM_DIR:-/opt/browser-check}"

# The default: the group attachment browser tests. More files can be passed
# as arguments.
if [ "$#" -gt 0 ]; then
  TEST_FILES="$*"
else
  TEST_FILES="tests/groups/group-attachment-browser.test.mjs"
fi

# The packages the harness resolves through CHROMIUM_DIR
# (tests/_acceptance-harness.mjs: launchBrowser()).
PUPPETEER_VERSION="${PUPPETEER_VERSION:-25.14.0}"
CHROMIUM_VERSION="${CHROMIUM_VERSION:-153.0.0}"

echo "tree:      $TREE"
echo "image:     $IMAGE"
echo "work:      $WORK"
echo "tests:     $TEST_FILES"
echo "NOTE: this recipe has NEVER been run on Linux by the agent that wrote it."

docker run --rm \
  -v "$TREE:/src:ro" \
  -v "$WORK:/work" \
  "$IMAGE" \
  bash -euxo pipefail -c "
    # The shared libraries the Chromium binary needs on a Debian slim image.
    # @sparticuz/chromium ships the AL2023 libraries itself (bin/al2023.tar.br,
    # extracted into /tmp/al2023), but the base image still needs these.
    apt-get update
    apt-get install -y --no-install-recommends \
      ca-certificates libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 fonts-liberation

    # The tree is mounted read-only: copy it somewhere writable.
    rm -rf /work/tree
    cp -a /src /work/tree
    cd /work/tree
    node --version
    npm ci --no-audit --no-fund

    # The browser packages live OUTSIDE the tree: the harness resolves them
    # through CHROMIUM_DIR (default /tmp/browser-check).
    mkdir -p '$CHROMIUM_DIR'
    cd '$CHROMIUM_DIR'
    npm init -y >/dev/null
    npm install --no-audit --no-fund \
      'puppeteer-core@$PUPPETEER_VERSION' '@sparticuz/chromium@$CHROMIUM_VERSION'

    cd /work/tree
    export CHROMIUM_DIR='$CHROMIUM_DIR'
    # The system-browser fallback stays OFF: on Linux the project's own
    # Chromium must be the engine that runs.
    unset WIRE_TEST_ALLOW_SYSTEM_BROWSER || true
    node --experimental-test-module-mocks --env-file=tests/test.env \
      --test --test-timeout=900000 $TEST_FILES
  "

echo "the browser tests passed (the TAP output above must name chromium (@sparticuz/chromium))"
