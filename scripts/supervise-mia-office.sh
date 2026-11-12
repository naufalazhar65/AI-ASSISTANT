#!/bin/bash
# supervise-mia-office.sh — watchdog untuk Mia (:3000) + office-dashboard (:3001).
#
# Kenapa script ini ada (observasi 2026-11-12):
#   Service yang mati diam-diam adalah kegagalan paling mahal di mesin ini:
#   dashboard mati → owner membuka panel → "connection refused", dan tidak ada
#   yang menyadari atau menyalakannya lagi. Pemeriksaan manual hanya terjadi
#   kalau owner ingat; watchdog yang ada hanya membuka tunnel, tidak menyalakan
#   proses yang mati.
#
# Aturan keras (dari AGENTS.md + restart-mia.sh):
#   - JANGAN `pkill -f "next dev"` / `pkill -f "next-server"`: proxy 9router
#     (LLM_API_BASE=http://127.0.0.1:20128/v1) juga next-server. Pembunuh
#     proses WAJIB per-port.
#   - tmux harus punya process group sendiri (setsid) dan diakhiri `sleep
#     infinity`, kalau tidak sesi-nya di-reap saat idle (lesson 2026-09-24).
#   - 9router (port 20128) TIDAK boleh disentuh sama sekali.
#
# Pemakaian:
#   ./scripts/supervise-mia-office.sh --start   # jalankan supervisor di tmux
#   ./scripts/supervise-mia-office.sh --run     # loop (dipakai di dalam tmux)
#   ./scripts/supervise-mia-office.sh --status  # cek sekali, tanpa restart
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/mia-supervisor.log
INTERVAL=30          # detik antar pemeriksaan
MIA_FAILS_TO_RESTART=3   # kegagalan berturut-turut sebelum Mia direstart
MIA_HEALTH_TIMEOUT=10

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

health_ok() {
  # $1 = port, $2 = timeout. Dashboard (:3001) /api/health TIDAK memakai
  # gerbang auth (route-nya ditangani sebelum gate /api/*). Mia (:3000) MEMAKAI
  # bearer, jadi token dibaca dari .env.local saat runtime (tidak pernah ditulis
  # ke log, tidak pernah disimpan di repo).
  if [ "$1" = "3000" ]; then
    if [ -z "${MIA_TOKEN:-}" ]; then
      log "mia: token tidak terbaca — pemeriksaan health dilewati (jangan restart karena tidak bisa cek)"
      return 0
    fi
    curl -fsS -m "$2" -H "Authorization: Bearer $MIA_TOKEN" "http://127.0.0.1:$1/api/health" >/dev/null 2>&1
    return $?
  fi
  curl -fsS -m "$2" "http://127.0.0.1:$1/api/health" >/dev/null 2>&1
}

read_mia_token() {
  local env="$ROOT/apps/web/.env.local"
  MIA_TOKEN=""
  [ -f "$env" ] || return 1
  MIA_TOKEN="$(grep -m1 '^AUTH_TOKEN=' "$env" 2>/dev/null | cut -d= -f2- | tr -d '"')"
  [ -n "$MIA_TOKEN" ]
}

restart_office() {
  log "office: health gagal — restart dashboard (port 3001)"
  # Kill per-port: proses yang memegang socket, bukan pola nama proses.
  pids="$(lsof -ti tcp:3001 2>/dev/null || true)"
  if [ -n "${pids:-}" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 15); do
      lsof -ti tcp:3001 >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  if "$ROOT/scripts/start-office.sh" >>"$LOG" 2>&1; then
    log "office: hidup lagi di port 3001"
  else
    log "office: GAGAL start ulang — lihat $LOG dan /tmp/office-dashboard.log"
  fi
}

restart_mia() {
  log "mia: health gagal $MIA_FAILS_TO_RESTART× berturut — restart Mia (+ office)"
  if "$ROOT/scripts/restart-mia.sh" >>"$LOG" 2>&1; then
    log "mia: restart selesai"
  else
    log "mia: restart GAGAL — lihat $LOG"
  fi
}

run_loop() {
  log "supervisor mulai (interval ${INTERVAL}s)"
  mia_fails=0
  while true; do
    read_mia_token || true
    if health_ok 3001 3; then
      :
    else
      restart_office
    fi

    if health_ok 3000 "$MIA_HEALTH_TIMEOUT"; then
      mia_fails=0
    else
      mia_fails=$((mia_fails + 1))
      log "mia: health gagal (${mia_fails}/${MIA_FAILS_TO_RESTART})"
      if [ "$mia_fails" -ge "$MIA_FAILS_TO_RESTART" ]; then
        restart_mia
        mia_fails=0
      fi
    fi
    sleep "$INTERVAL"
  done
}

case "${1:---run}" in
  --start)
    if tmux has-session -t supervisor 2>/dev/null; then
      echo "supervisor sudah jalan di tmux session 'supervisor'"
      exit 0
    fi
    tmux new-session -d -s supervisor "$ROOT/scripts/supervise-mia-office.sh --run" 2>/dev/null || true
    if ! tmux has-session -t supervisor 2>/dev/null; then
      echo "retry: start tmux via setsid"
      perl -e 'use POSIX; POSIX::setsid(); exec @ARGV;' \
        tmux new-session -d -s supervisor "$ROOT/scripts/supervise-mia-office.sh --run"
    fi
    sleep 1
    if tmux has-session -t supervisor 2>/dev/null; then
      echo "supervisor jalan di tmux session 'supervisor' (log $LOG)"
      exit 0
    fi
    echo "ERROR: supervisor tidak jalan" >&2
    exit 1
    ;;
  --status)
    read_mia_token || true
    for p in 3001 3000; do
      if health_ok "$p" 5; then echo "port $p: OK"; else echo "port $p: DEAD"; fi
    done
    ;;
  --run)
    run_loop
    ;;
  *)
    echo "pemakaian: --start | --run | --status" >&2
    exit 2
    ;;
esac
