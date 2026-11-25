#!/bin/bash
# Q3: what the real server answers for Origin wire-bundled://app (reads middleware/cors.js: origin:true, credentials:false)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; IP="${NLIP:-$(hostname -I | awk '{print $1}')}"; PORT="${SPORT:-4778}"
W="$(mktemp -d)"; mkdir -p "$W"/{db,ud,tmp,chat,dm,group,av,ban}; cd "$ROOT"
SETUP_COMPLETED=true NODE_ENV=development PORT=$PORT HOST=0.0.0.0 ALLOWED_SUBNET=0.0.0.0/0 CSP_ENFORCE=false EMAIL_ENABLED=false \
 DB_PATH=$W/db/wire.db USER_DATA_ROOT=$W/ud TMPDIR=$W/tmp CHAT_UPLOAD_DIR=$W/chat DM_UPLOAD_DIR=$W/dm GROUP_UPLOAD_DIR=$W/group AVATAR_DIR=$W/av BANNER_DIR=$W/ban \
 JWT_SECRET=$(head -c32 /dev/urandom | xxd -p -c64) EMAIL_VERIFICATION_SECRET=$(head -c32 /dev/urandom | xxd -p -c64) node server.js > "$W/server.log" 2>&1 &
SP=$!; for i in $(seq 1 30); do curl -s -m 2 "http://$IP:$PORT/api/version" >/dev/null && break; sleep 1; done
echo '$ GET with Origin: wire-bundled://app'; curl -s -i -m 5 -H "Origin: wire-bundled://app" "http://$IP:$PORT/api/version" | grep -i -E "^HTTP|access-control|vary|^\{"
echo '$ OPTIONS preflight'; curl -s -i -m 5 -X OPTIONS -H "Origin: wire-bundled://app" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,authorization" "http://$IP:$PORT/api/version" | grep -i -E "^HTTP|access-control|vary"
echo '$ GET without Origin'; curl -s -i -m 5 "http://$IP:$PORT/api/version" | grep -i -E "^HTTP|access-control"
kill $SP 2>/dev/null; rm -rf "$W"
