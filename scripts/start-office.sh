#!/bin/bash
# start-office.sh — nyalakan AI Office Dashboard (port 3001).
#
# Kenapa script ini ada (observasi 2026-10-12):
#   Sesi dashboard sebelumnya dijalankan manual dengan `tmux new-session`, dan
#   ikut hilang saat tmux server di-reap — persis hazard yang sudah dicatat di
#   restart-mia.sh ("tmux di-reap saat idle"). Akibatnya dashboard mati diam-diam
#   setiap kali Mia direstart, lalu `/api/queue` balas connection refused.
#
# Pola yang dipakai (sama dengan restart-mia.sh, dan itu bukan kebetulan):
#   - `setsid`  → tmux server punya process group sendiri, tidak ikut kena
#                 dongkolan process tree dari shell pemanggil.
#   - `sleep infinity` di akhir perintah → sesi tidak berakhir saat proses
#                 utamanya selesai, jadi tidak ada alasan bagi server untuk mati.
#   - Health check setelah start → "jalan" berarti socket benar-benar menerima,
#                 bukan sekadar "tidak ada error di log".
set -u

PORT=3001
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/office-dashboard"

if lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "office-dashboard sudah jalan di port $PORT (pid $(lsof -tiTCP:$PORT -sTCP:LISTEN | tr '\n' ' '))."
    exit 0
  fi
  # Portnya dipegang tapi tidak menjawab = proses macet. Membunuhnya lebih
  # jujur daripada melapor "sudah jalan": supervisor pernah mencatat "hidup
  # lagi" padahal dashboard tetap mati.
  echo "port $PORT dipegang proses yang tidak menjawab — dibunuh lalu start ulang"
  stale="$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "${stale:-}" ]; then
    # shellcheck disable=SC2086
    kill $stale 2>/dev/null || true
    for _ in $(seq 1 10); do
      lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 1
    done
  fi
fi

tmux kill-session -t office 2>/dev/null || true

start_session() {
  tmux new-session -d -s office "cd $ROOT/apps/office-dashboard && node server.js 2>&1 | tee /tmp/office-dashboard.log; sleep infinity"
}

start_session 2>/dev/null || true
if ! tmux has-session -t office 2>/dev/null; then
  echo "retry: start tmux via setsid"
  perl -e 'use POSIX; POSIX::setsid(); exec @ARGV;' \
    tmux new-session -d -s office "cd $ROOT/apps/office-dashboard && node server.js 2>&1 | tee /tmp/office-dashboard.log; sleep infinity"
fi

# Tunggu socket benar-benar menerima — jangan percaya log yang kosong.
for _ in $(seq 1 25); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "office-dashboard OK di http://127.0.0.1:$PORT (pid $(lsof -tiTCP:$PORT -sTCP:LISTEN | tr '\n' ' '))"
    exit 0
  fi
  sleep 1
done

echo "ERROR: dashboard tidak answering di port $PORT" >&2
tail -20 /tmp/office-dashboard.log >&2 || true
exit 1