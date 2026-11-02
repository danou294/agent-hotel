#!/bin/sh
# Lance le serveur, puis (si RUN_BOTS=1) les personnages scriptés une fois le serveur prêt.
set -e
node packages/server/dist/index.js &
SERVER=$!
if [ "${RUN_BOTS:-0}" = "1" ]; then
  (
    for i in $(seq 1 30); do
      if wget -qO- "http://127.0.0.1:${PORT:-4000}/api/health" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    while true; do
      HOTEL_URL="http://127.0.0.1:${PORT:-4000}" node packages/bots/dist/index.js || true
      sleep 5
    done
  ) &
fi
wait $SERVER
