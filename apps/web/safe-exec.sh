#!/usr/bin/env bash
# safe-exec — wrapper for safe command execution
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ "${SAFE_EXEC_DISABLE:-}" == "1" ]]; then exec "$@"; fi
# delegate to Node guard
CMD="$*"
RES="$(cd "$SCRIPT_DIR" && npx --yes tsx -e "
import { guard } from './src/lib/safeExec.ts';
const cmd = process.argv[1];
const r = guard(cmd);
console.log(JSON.stringify(r));
" -- "$CMD" 2>/dev/null)"
ALLOW="$(echo "$RES" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('allow', True))" 2>/dev/null || echo "True")"
if [[ "$ALLOW" == "True" || "$ALLOW" == "true" ]]; then exec "$@"
else
  ID="$(echo "$RES" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('requestId',''))" 2>/dev/null)"
  echo "Blocked by SafeExec — approval required: $ID" >&2
  exit 403
fi
