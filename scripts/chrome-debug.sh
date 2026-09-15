#!/usr/bin/env bash
# Launch a debuggable Chrome for Mia's AUTHENTICATED testing (CDP bridge).
#
# Mia talks to this browser over 127.0.0.1 only; your session cookies/tokens stay
# in this profile and are never sent to the AI provider. Use a DEDICATED profile
# (default ~/.mia-chrome) — log into test/engagement accounts there, not your
# personal ones.
#
# Usage:
#   scripts/chrome-debug.sh
#   CDP_PORT=9333 scripts/chrome-debug.sh
#   CHROME_APP="/Applications/Chromium.app/Contents/MacOS/Chromium" scripts/chrome-debug.sh
set -euo pipefail

PORT="${CDP_PORT:-9222}"
PROFILE="${CDP_PROFILE:-$HOME/.mia-chrome}"

APP="${CHROME_APP:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [[ ! -x "$APP" ]]; then
  for c in \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"; do
    if [[ -x "$c" ]]; then APP="$c"; break; fi
  done
fi
if [[ ! -x "$APP" ]]; then
  echo "!! Chrome/Chromium tidak ditemukan. Set CHROME_APP ke path binary-nya." >&2
  exit 1
fi

mkdir -p "$PROFILE"
cat <<EOF
🌸 Chrome debug untuk Mia
   port     : $PORT
   profil   : $PROFILE
   binary   : $APP

Langkah: login ke app target di jendela ini, lalu Mia bisa:
   cdp_status                     # lihat tab
   cdp_request tab=<host> url=<...> method=GET
   cdp_request tab=<host> url=<...> method=POST body=... token_from="localStorage.getItem('token')"
   cdp_eval    tab=<host> expr="document.cookie"
EOF

# Chrome >=136 refuses --remote-debugging-port on the default profile, hence a
# dedicated --user-data-dir.
exec "$APP" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --restore-last-session
