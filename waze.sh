#!/usr/bin/env bash
# Wrapper — delegates to apps/web/waze.sh (single source of truth)
exec "$(dirname "$0")/apps/web/waze.sh" "$@"
