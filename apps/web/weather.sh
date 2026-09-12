#!/usr/bin/env bash
# Weather Jakarta — Free (wttr.in + Open-Meteo, no key)
# Usage: ./weather.sh "BSD City"  |  ./weather.sh "Jakarta"  |  ./weather.sh "-6.30,106.64"
set -euo pipefail
if [[ $# -lt 1 ]]; then echo "Usage: $0 \"<location or lat,lon>\"" >&2; exit 1; fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if command -v node >/dev/null 2>&1 && [[ -f "$SCRIPT_DIR/src/lib/weather.ts" ]]; then
  cd "$SCRIPT_DIR" && exec npx --yes tsx -e "
import { getWeather } from './src/lib/weather.ts';
const q = process.argv.slice(1).join(' ');
getWeather(q).then(r=>{
  console.log(JSON.stringify({location:r.location,temp_c:r.temp_c,desc:r.desc,humidity:r.humidity,wind_kmh:r.wind_kmh,time:r.time}, null, 2));
  console.log('');
  console.log(r.human);
}).catch(e=>{ console.error(e instanceof Error?e.message:String(e)); process.exit(1); });
" -- "$1"
fi
echo "node/tsx not available" >&2; exit 1
