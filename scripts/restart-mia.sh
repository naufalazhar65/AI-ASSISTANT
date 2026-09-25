# restart-mia.sh — restart HANYA server Mia (port 3000).
#
# JANGAN pernah pakai `pkill -f "next dev"` atau `pkill -f "next-server"` di
# mesin ini: proxy 9router (LLM_API_BASE=http://127.0.0.1:20128/v1) juga
# berjalan sebagai `next-server (v16.2.1)` — pattern itu akan membunuhnya
# (terjadi 2026-09-25 11:33, AGENTS sudah memperingatkan: "jangan salah sangka
# dobel-instance Next"). Pembunuh proses WAJIB per-port, dan tidak boleh
# menyasar host lain.
set -u

PORT=3000
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1. Kill HANYA proses yang memegang port 3000.
PIDS="$(lsof -ti tcp:$PORT 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "killing port $PORT pids: $PIDS"
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
fi

# 2. Tunggu port benar-benar bebas (TIDAK ada sleep buta).
for _ in $(seq 1 25); do
  if ! lsof -ti tcp:$PORT >/dev/null 2>&1; then break; fi
  sleep 1
done
if lsof -ti tcp:$PORT >/dev/null 2>&1; then
  echo "ERROR: port $PORT masih dipakai — batal, jangan start yang kedua." >&2
  exit 1
fi

# 3. Jaga tmux server tetap hidup (tmux di-reap saat idle — lesson 2026-09-24).
tmux kill-session -t mia 2>/dev/null || true
rm -rf apps/web/.next

# 4. Start.
tmux new-session -d -s mia "npm run dev -w @voice/web 2>&1 | tee /tmp/mia-dev.log; sleep infinity"

# 5. Verifikasi.
for i in $(seq 1 60); do
  case "$(curl -s -m 5 http://localhost:$PORT/api/health 2>/dev/null)" in
    '{"ok":true'*) echo "health ok after ${i}s"; break ;;
  esac
  sleep 1
done

echo "health        : $(curl -s -m 10 http://localhost:$PORT/api/health | head -c 80)"
echo "logged_in_as  : $(grep -c 'logged in as' /tmp/mia-dev.log 2>/dev/null || echo 0)  (harus 1)"
echo "telegram      : $(grep -c 'telegram] starting' /tmp/mia-dev.log 2>/dev/null || echo 0)  (harus 1)"
echo "409 conflicts : $(grep -c 409 /tmp/mia-dev.log 2>/dev/null || echo 0)  (harus 0)"
echo "chunk errors  : $(grep -c 'Cannot find module' /tmp/mia-dev.log 2>/dev/null || echo 0)  (harus 0)"
echo "boot time     : $(ps -o lstart= -p "$(lsof -ti tcp:$PORT | head -1)" 2>/dev/null)"
echo "agent.ts mtime: $(stat -f '%Sm' apps/web/src/lib/agent.ts)"

# 6. JANGAN sentuh 20128 — laporkan saja statusnya.
echo "--- 9router (JANGAN DIKILL) ---"
if lsof -ti tcp:20128 >/dev/null 2>&1; then
  echo "9router pid   : $(lsof -ti tcp:20128 | head -1)  (alive ✓)"
  echo "9router /v1   : $(curl -s -m 8 http://127.0.0.1:20128/v1/models | head -c 60)"
else
  echo "9router MATI — start manual: tmux new-session -d -s 9router '9router -p 20128; sleep infinity'" >&2
fi
