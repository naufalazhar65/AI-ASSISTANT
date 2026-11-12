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
OFFICE_FAILS_TO_RESTART=2  # dashboard: 2 kegagalan (satu timeout ≠ mati)
OFFICE_HEALTH_TIMEOUT=8

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

# LIVENESS, bukan readiness. Proses hidup = route menjawab sama sekali.
# Mia (:3000) memakai gerbang auth, jadi tanpa token jawabannya 401 — itu tetap
# "hidup"; yang MATI: tidak ada yang menjawab (000) atau route error (500 =
# build .next rusak). Dulu skrip ini butuh token dari .env.local; token yang
# tidak terbaca membuat Mia terlihat SEHAT selamanya (fail-open) dan parsing
# token yang rapuh (CRLF, kutip) memicu badai restart. Tidak ada lagi rahasia
# di skrip ini.
# Dashboard (:3001) tidak memakai auth, tapi body-nya dicek: kalau proses lain
# memegang :3001, itu BUKAN dashboard → terdeteksi, bukan lolos sebagai sehat.
health_ok() {
  local out code body
  out="$(curl -s -m "$2" -w '\n%{http_code}' "http://127.0.0.1:$1/api/health" 2>/dev/null || true)"
  code="$(printf '%s' "$out" | tail -n 1)"
  body="$(printf '%s' "$out" | sed '$d')"
  case "$code" in
    200|401|403|503) ;;
    *) return 1 ;;
  esac
  if [ "$1" = "3001" ]; then
    case "$body" in *'"uptime_s"'*) return 0 ;; *) return 1 ;; esac
  fi
  return 0
}

restart_office() {
  log "office: health gagal — restart dashboard (port 3001)"
  # Kill HANYA proses yang MEMEGANG LISTENER di port 3001. `lsof -ti tcp:3001`
  # juga menyodorkan socket client — Chrome owner ikut kena kill tiap restart.
  local pids
  pids="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "${pids:-}" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 15); do
      lsof -tiTCP:3001 -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 1
    done
    # Masih memegang port? Prosesnya macet — paksa, jangan tunggu selamanya.
    pids="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "${pids:-}" ]; then
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
      sleep 2
    fi
  fi
  if "$ROOT/scripts/start-office.sh" >>"$LOG" 2>&1 && health_ok 3001 5; then
    log "office: hidup lagi di port 3001"
  else
    log "office: GAGAL start ulang — lihat $LOG dan /tmp/office-dashboard.log"
  fi
}

restart_mia() {
  log "mia: health gagal $MIA_FAILS_TO_RESTART× berturut — restart Mia (+ office)"
  "$ROOT/scripts/restart-mia.sh" >>"$LOG" 2>&1
  local rc=$?
  case "$rc" in
    0) log "mia: restart selesai"; return 0 ;;
    2) log "mia: restart sudah berjalan (lock) — tidak interferes"; return 0 ;;
    *) log "mia: restart GAGAL (rc=$rc) — lihat $LOG"; return 1 ;;
  esac
}

run_loop() {
  log "supervisor mulai (interval ${INTERVAL}s)"
  mia_fails=0
  office_fails=0
  while true; do
    if health_ok 3001 "$OFFICE_HEALTH_TIMEOUT"; then
      office_fails=0
    else
      office_fails=$((office_fails + 1))
      log "office: health gagal (${office_fails}/${OFFICE_FAILS_TO_RESTART})"
      if [ "$office_fails" -ge "$OFFICE_FAILS_TO_RESTART" ]; then
        restart_office
        office_fails=0
      fi
    fi

    if health_ok 3000 "$MIA_HEALTH_TIMEOUT"; then
      mia_fails=0
    else
      mia_fails=$((mia_fails + 1))
      log "mia: health gagal (${mia_fails}/${MIA_FAILS_TO_RESTART})"
      if [ "$mia_fails" -ge "$MIA_FAILS_TO_RESTART" ]; then
        if restart_mia; then
          mia_fails=0
        else
          # Restart gagal: jangan ulangi tiap 30 s (rm -rf .next tiap percobaan
          # = CPU penuh + Mia tetap mati). Beri jeda sebelum mencoba lagi.
          log "mia: restart gagal — jeda 90 s sebelum mencoba lagi"
          sleep 90
        fi
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
    # `sleep infinity` di akhir: kalau loop-nya berhenti, sesi tmux ikut
    # berakhir dan watchdog hilang tanpa satu baris log (header file ini
    # sendiri meminta aturan itu — sekarang jalannya comply).
    tmux new-session -d -s supervisor "$ROOT/scripts/supervise-mia-office.sh --run; sleep infinity" 2>/dev/null || true
    if ! tmux has-session -t supervisor 2>/dev/null; then
      echo "retry: start tmux via setsid"
      perl -e 'use POSIX; POSIX::setsid(); exec @ARGV;' \
        tmux new-session -d -s supervisor "$ROOT/scripts/supervise-mia-office.sh --run; sleep infinity"
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
    # Read-only: tidak menulis ke log, tidak menyentuh proses apa pun.
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
