#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" && npx --yes tsx -e "
import { listPending } from './src/lib/safeExec.ts';
const list = listPending();
if (!list.length) console.log('No pending requests');
else list.forEach(r=>console.log(\`\${r.id} | \${r.risk} | \${r.command} | \${r.reason}\`));
"
