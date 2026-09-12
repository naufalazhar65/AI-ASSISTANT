#!/usr/bin/env bash
# Waze Direct — Free live traffic via Waze (no API key, no fetcher)
# Usage:
#   ./waze.sh "Monas, Jakarta" "BSD City, Tangerang"
#   ./waze.sh "-6.1754,106.8272" "-6.3025,106.6528"
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 \"<from address or lat,lon>\" \"<to address or lat,lon>\"" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Prefer the Node lib (single source of truth); fall back to pure bash if node missing.
if command -v node >/dev/null 2>&1 && [[ -f "$SCRIPT_DIR/src/lib/waze.ts" ]]; then
  cd "$SCRIPT_DIR" && exec npx --yes tsx -e "
import { getWazeRoute, formatWazeJson } from './src/lib/waze.ts';
const [from, to] = process.argv.slice(1);
getWazeRoute(from, to).then(r => {
  console.log(formatWazeJson(r));
  console.log('');
  console.log(r.human);
}).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
" -- "$1" "$2"
fi

# --- Pure bash fallback (curl + jq) ---
FROM="$1"
TO="$2"
UA="mia-assistant/1.0 (https://github.com/naufalazhar65/AI-ASSISTANT)"

is_latlon() { [[ "$1" =~ ^[[:space:]]*-?[0-9]+(\.[0-9]+)?[[:space:]]*,[[:space:]]*-?[0-9]+(\.[0-9]+)?[[:space:]]*$ ]]; }

geocode() {
  local q="$1"
  if is_latlon "$q"; then
    local lat lon
    lat="$(echo "$q" | cut -d, -f1 | xargs)"; lon="$(echo "$q" | cut -d, -f2 | xargs)"
    echo "{\"lat\":$lat,\"lon\":$lon}"
    return
  fi
  local url="https://nominatim.openstreetmap.org/search?q=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$q")&format=json&limit=1"
  local res
  res="$(curl -sS -A "$UA" -H "Accept: application/json" "$url")"
  local lat lon
  lat="$(echo "$res" | python3 -c "import json,sys; a=json.load(sys.stdin); print(a[0]['lat'] if a else '')" 2>/dev/null)"
  lon="$(echo "$res" | python3 -c "import json,sys; a=json.load(sys.stdin); print(a[0]['lon'] if a else '')" 2>/dev/null)"
  if [[ -z "$lat" || -z "$lon" ]]; then echo "Cannot get coords for \"$q\"" >&2; exit 1; fi
  echo "{\"lat\":$lat,\"lon\":$lon}"
}

FROM_JSON="$(geocode "$FROM")"
# throttle 1/s for Nominatim
if ! is_latlon "$FROM" && ! is_latlon "$TO"; then sleep 1; fi
TO_JSON="$(geocode "$TO")"

FROM_LAT="$(echo "$FROM_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['lat'])")"
FROM_LON="$(echo "$FROM_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['lon'])")"
TO_LAT="$(echo "$TO_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['lat'])")"
TO_LON="$(echo "$TO_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['lon'])")"

WAZE_URL="https://routing-livemap-row.waze.com/RoutingManager/routingRequest?from=x:${FROM_LON}%20y:${FROM_LAT}&to=x:${TO_LON}%20y:${TO_LAT}&at=0&nPaths=3&options=AVOID_TRAILS:t"

echo "→ Waze: $WAZE_URL" >&2
WAZE_RES="$(curl -sS -A "Mozilla/5.0" -H "Referer: https://www.waze.com/" -H "Accept: application/json" "$WAZE_URL" || true)"

if echo "$WAZE_RES" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'alternatives' in d or 'response' in d" 2>/dev/null; then
  echo "$WAZE_RES" | python3 -m json.tool
else
  echo "Waze failed or blocked, trying OSRM…" >&2
  OSRM_URL="https://router.project-osrm.org/route/v1/driving/${FROM_LON},${FROM_LAT};${TO_LON},${TO_LAT}?overview=false&alternatives=true"
  curl -sS -A "$UA" "$OSRM_URL" | python3 -m json.tool
fi
