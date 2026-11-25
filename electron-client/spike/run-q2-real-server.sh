#!/bin/bash
# Q2/Q3 spike runner. Usage (from electron-client/): bash spike/run-q2-real-server.sh
# Needs: npm ci in repo root (server deps) and electron-client/, xvfb-run, a non-loopback IPv4 address.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IP="${NLIP:-$(hostname -I | awk '{print $1}')}"
PORT="${SPORT:-4777}"
echo "non-loopback IP: $IP (from: hostname -I)  port: $PORT"
[ -z "$IP" ] && { echo "NO non-loopback address: Q2 [NOT VERIFIED]"; exit 2; }
W="$(mktemp -d)"; mkdir -p "$W"/{db,ud,tmp,chat,dm,group,av,ban}
cd "$ROOT"
SETUP_COMPLETED=true NODE_ENV=development PORT=$PORT HOST=0.0.0.0 ALLOWED_SUBNET=0.0.0.0/0 CSP_ENFORCE=false EMAIL_ENABLED=false \
 DB_PATH=$W/db/wire.db USER_DATA_ROOT=$W/ud TMPDIR=$W/tmp CHAT_UPLOAD_DIR=$W/chat DM_UPLOAD_DIR=$W/dm GROUP_UPLOAD_DIR=$W/group AVATAR_DIR=$W/av BANNER_DIR=$W/ban \
 JWT_SECRET=$(head -c32 /dev/urandom | xxd -p -c64) EMAIL_VERIFICATION_SECRET=$(head -c32 /dev/urandom | xxd -p -c64) node server.js > "$W/server.log" 2>&1 &
SP=$!
for i in $(seq 1 30); do curl -s -m 2 "http://$IP:$PORT/api/version" >/dev/null && break; sleep 1; done
echo "server: $(curl -s -m 3 http://$IP:$PORT/api/version)"
cd "$ROOT/electron-client"
NLIP=$IP SPORT=$PORT timeout 90 xvfb-run -a node_modules/electron/dist/electron --no-sandbox --disable-gpu spike/test-q2-real-server.js 2>&1 | grep -v -E "dbus|DevTools|deprecated|ERROR:.*(gpu|bus|viz)"
kill $SP 2>/dev/null; rm -rf "$W"
