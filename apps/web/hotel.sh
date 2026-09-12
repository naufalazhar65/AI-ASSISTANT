#!/usr/bin/env bash
# Hotel Finder — Booking.com via Playwright
# Usage: ./hotel.sh "Bandung" "400rb"  |  ./hotel.sh "Jakarta" "600rb"  |  ./hotel.sh "Jakarta"
set -euo pipefail
if [[ $# -lt 1 ]]; then echo "Usage: $0 \"<location>\" [\"<budget>\"]" >&2; exit 1; fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOC="$1"
BUDGET="${2:-}"
if command -v node >/dev/null 2>&1 && [[ -f "$SCRIPT_DIR/src/lib/hotel.ts" ]]; then
  cd "$SCRIPT_DIR" && exec npx --yes tsx -e "
import { getHotels } from './src/lib/hotel.ts';
const loc = process.argv[1];
const budget = process.argv[2] || undefined;
getHotels(loc, budget).then(r=>{
  console.log(r.human);
  console.log('');
  console.log(JSON.stringify({ location:r.location, budget:r.budget, checkin:r.checkin, checkout:r.checkout, hotels:r.hotels }, null, 2));
}).catch(e=>{ console.error(e instanceof Error?e.message:String(e)); process.exit(1); });
" -- "$LOC" "$BUDGET"
fi
echo "node/tsx not available" >&2; exit 1
