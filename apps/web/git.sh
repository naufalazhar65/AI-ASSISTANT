#!/usr/bin/env bash
# Git Helper — Mia commit dong (pure git, no API key)
# Usage: ./git.sh "feat: tambah fitur X"  |  ./git.sh --status
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [[ "${1:-}" == "--status" || "${1:-}" == "status" ]]; then
  git status --short --branch
  exit 0
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 \"<commit message>\"  |  $0 --status" >&2
  exit 1
fi

MSG="$1"
if [[ -z "$(git status --porcelain)" ]]; then
  echo "working tree clean — nothing to commit"
  exit 0
fi

git add -A
# allow empty message handling
if git diff --cached --quiet; then
  echo "working tree clean — nothing staged"
  exit 0
fi

git commit -m "$MSG"
# push to origin/main if remote exists, else just local commit
if git remote get-url origin >/dev/null 2>&1; then
  git push origin HEAD
  echo "push done — $(git rev-parse --short HEAD)"
else
  echo "commit done (no remote) — $(git rev-parse --short HEAD)"
fi
