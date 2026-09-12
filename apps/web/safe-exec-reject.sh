#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 1 ]]; then echo "Usage: $0 <request_id>" >&2; exit 1; fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" && npx --yes tsx -e "
import { reject } from './src/lib/safeExec.ts';
const ok = reject(process.argv[1]);
console.log(ok ? 'Rejected' : 'Not found');
process.exit(ok?0:1);
" -- "$1"
