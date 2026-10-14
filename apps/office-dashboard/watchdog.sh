#!/usr/bin/env bash
# Office Dashboard watchdog — health-check the dashboard and (only when
# everything is genuinely ready) keep a `bore` tunnel alive.
#
# Rules encoded here (spec §9):
#   * a tunnel is only opened when `bore` exists AND dashboard auth is enabled
#   * "healthy" means a real HTTP 200 from the public URL, not "process alive"
#   * no credentials are ever written to this script or to the history file
#   * every run appends one honest JSON line to watchdog-history.jsonl
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3001}"
HOST="127.0.0.1"
BASE="http://${HOST}:${PORT}"
MIA_ENV="$(cd "$ROOT/.." && pwd)/web/.env.local"
PUBLIC_URL_FILE="$ROOT/PUBLIC_URL.txt"
HISTORY="$ROOT/watchdog-history.jsonl"
TUNNEL_LOG="/tmp/office-dashboard-tunnel.log"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# $1 ok(true|false) $2 action $3 url(json|null) $4 error(optional)
history() {
  printf '{"ts":"%s","ok":%s,"action":"%s","url":%s%s}\n' \
    "$(now)" "$1" "$2" "$3" "${4:+,\"error\":\"$4\"}" >> "$HISTORY"
}
json_url() { [ -n "$1" ] && printf '"%s"' "$1" || printf 'null'; }

# 0. auth must be ON before anything is exposed (same source server.js reads)
auth_enabled() {
  if [ -n "${DASHBOARD_TOKEN:-}" ]; then echo enabled; return; fi
  if [ -f "$MIA_ENV" ] && grep -qE '^[[:space:]]*AUTH_TOKEN=.+' "$MIA_ENV"; then
    echo enabled; return
  fi
  echo disabled
}

# 1. dashboard itself — real HTTP, with timeout
code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/api/health" 2>/dev/null)"
# curl already prints 000 when it cannot connect; do NOT append another fallback,
# or the log records a nonsense status like "HTTP 000000".
[ -n "$code" ] || code="000"
if [ "$code" != "200" ]; then
  history false "dashboard_unreachable" null "HTTP $code"
  echo "[watchdog] dashboard tidak merespons di $BASE (HTTP $code)"
  exit 1
fi

# 2. tunnel is refused until auth is on
if [ "$(auth_enabled)" != "enabled" ]; then
  history true "auth_disabled_tunnel_refused" null
  echo "[watchdog] dashboard sehat, auth belum aktif — tunnel TIDAK dibuka."
  exit 0
fi

# 3. no bore binary -> nothing to do
if ! command -v bore >/dev/null 2>&1; then
  history true "bore_not_installed" null
  echo "[watchdog] dashboard sehat — 'bore' tidak terpasang, tunnel dilewati."
  exit 0
fi

# 4. existing tunnel must answer HTTP 200
URL="$(tr -d '[:space:]' < "$PUBLIC_URL_FILE" 2>/dev/null || true)"
if [ -n "$URL" ]; then
  pub_code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$URL" 2>/dev/null || echo 000)"
  if [ "$pub_code" = "200" ]; then
    history true "tunnel_ok" "$(json_url "$URL")"
    echo "[watchdog] tunnel OK (HTTP $pub_code) $URL"
    exit 0
  fi
  echo "[watchdog] tunnel publik tidak sehat (HTTP $pub_code) — restart"
  pkill -f "bore local $PORT" >/dev/null 2>&1 || true
fi

# 5. (re)start and VERIFY before publishing the URL
echo "[watchdog] membuka tunnel baru via bore (log: $TUNNEL_LOG)"
nohup bore local "$PORT" --to bore.pub > "$TUNNEL_LOG" 2>&1 &
sleep 5
NEW_URL="$(grep -oE 'https://[a-z0-9.-]+\.bore\.pub(:[0-9]+)?' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
if [ -z "$NEW_URL" ]; then
  PORTNUM="$(grep -oE 'listening at bore\.pub:[0-9]+' "$TUNNEL_LOG" 2>/dev/null | grep -oE '[0-9]+$' | head -1 || true)"
  [ -n "$PORTNUM" ] && NEW_URL="https://bore.pub:$PORTNUM"
fi
if [ -z "$NEW_URL" ]; then
  history false "tunnel_start_failed" null "URL tidak ditemukan di $TUNNEL_LOG"
  echo "[watchdog] tunnel gagal start."
  exit 1
fi
new_code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$NEW_URL" 2>/dev/null || echo 000)"
if [ "$new_code" != "200" ]; then
  history false "tunnel_not_verified" "$(json_url "$NEW_URL")" "HTTP $new_code"
  echo "[watchdog] tunnel baru tidak terverifikasi (HTTP $new_code) — URL tidak dipublikasikan."
  exit 1
fi
printf '%s\n' "$NEW_URL" > "$PUBLIC_URL_FILE"
history true "tunnel_restarted" "$(json_url "$NEW_URL")"
echo "[watchdog] tunnel baru siap & terverifikasi HTTP 200: $NEW_URL"