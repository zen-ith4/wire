#!/bin/bash
# Run from electron-client/:  bash spike/run-q1-persistence.sh
set -u
E=node_modules/electron/dist/electron; UD=$(mktemp -d); OTHER=$(mktemp -d)
run() { Q1_UD=$1 Q1_MODE=$2 timeout 60 xvfb-run -a $E --no-sandbox --disable-gpu spike/test-q1-persistence.js 2>&1 | grep '^\[q1\]'; }
echo "# RUN 1 (write) userData=$UD";            run "$UD" write
echo "# RUN 2 (read only, new process, same userData)"; run "$UD" read
echo "# CONTROL (read only, different userData=$OTHER)"; run "$OTHER" read
rm -rf "$UD" "$OTHER"
