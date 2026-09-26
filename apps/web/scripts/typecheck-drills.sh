#!/usr/bin/env bash
# Drill/probe typecheck — reports, does not fail (2026-09-27)
#
# The main tsconfig includes only `**/*.ts` and `**/*.tsx`, so every `.mts`
# drill/probe script has NEVER been typechecked. That is not theoretical: it hid
# `listFindings` (which does not exist — it is `readFindings`) and a `cdp_eval`
# result read as `.value` when the function returns a plain string, which made a
# drill assertion silently vacuous while still reporting a pass.
#
# This reports rather than gates. Making the drills a hard gate today would fail
# the build on pre-existing errors that are mostly the deliberate ToolCall
# dual-shape (the confirm executor reads top-level `name`/`arguments`, while a
# replaying gateway requires nested `function.*`). Reporting keeps the number
# visible so the baseline can only shrink. Baseline: 22 errors, 2026-09-27.
#
# Run: npm run typecheck:drills -w @voice/web
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=$(npx tsc --noEmit -p tsconfig.drills.json 2>&1 || true)
COUNT=$(printf '%s\n' "$OUT" | grep -c "error TS" || true)
echo "drill/probe typecheck: ${COUNT} error (baseline 22 — ratchet, should only shrink)"
if [ "${COUNT}" != "0" ]; then
  printf '%s\n' "$OUT" | grep "error TS" | head -20
fi
exit 0
