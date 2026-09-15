name: authenticated-testing
description: Uji bug bounty ber-autentikasi lewat CDP ke browser user (sesi asli, rahasia tak masuk LLM) — kebanyakan bug nyata ada di belakang login.

# Authenticated testing (via CDP)

## Kenapa
Mayoritas bug bounty nyata (IDOR/BOLA, privilege escalation, business logic,
auth bypass) ada **di belakang login**. Dua penghalang umum:
1. WAF/Cloudflare memblokir request programatik (curl / fetch manual).
2. Menyerahkan cookie/token ke LLM = bocor ke pihak ketiga.

Solusi: Mia mengendalikan **browser milik user** lewat Chrome DevTools Protocol
lokal (127.0.0.1), dan menjalankan request **di dalam tab** — browser memegang
rahasia, hanya **respons** yang kembali.

## Setup (user, sekali)
```
scripts/chrome-debug.sh          # Chrome dengan --remote-debugging-port=9222
# di jendela itu: login ke app target (akun uji/engagement, BUKAN akun pribadi)
cdp_status                       # Mia lihat tab
```

## Alur Mia
1. `cdp_status` → pastikan Chrome terjangkau + tab app terbuka.
2. **Request ber-sesi** (cookie + CF clearance otomatis):
   ```
   cdp_request tab=member.app.com url=https://app.com/api/profile method=GET
   ```
3. **Bearer token tanpa bocor** — evaluasi ekspresi in-page saat request:
   ```
   cdp_request tab=app.com url=https://app.com/api/me method=GET \
     token_from="localStorage.getItem('access_token')"
   ```
   Token hanya ada di browser; argumen Mia tak memuatnya.
4. **Baca state halaman** (kunci/sesi/flag) via `cdp_eval`:
   ```
   cdp_eval tab=app.com expr="Object.keys(localStorage)"
   cdp_eval tab=app.com expr="document.cookie"
   ```
5. **Tamper in-flight** (IDOR/mass assignment) — pasang patch lalu trigger UI:
   `tamper_script url_contains=UpdateUserProfile set={"UserId":"999999"}` →
   `cdp_eval tab=app.com expr="<paste skrip>"` → klik Save di UI (atau panggil
   handler) → baca respons di Network/CDP.

## Triage (jangan inflate)
| Hasil | Arti |
|---|---|
| 200 + data identitas lain | IDOR/BOLA → lanjut finding |
| 401/403 saat id diubah | terkontrol → tutup (server mengikat id ke token) |
| error integritas (`enc_data`/signature) | body di-MAC → tak bisa ditamper |
| field privilege tak muncul saat GET ulang | mass assignment diabaikan |

## Batas & etika
- Hanya **akun sendiri / target ber-engagement**; scope-gate berlaku per host/tab.
- Jangan menyerang user lain; buktikan dengan **dua akun milikmu** (A/B).
- Profil debug berisi cookie sesi — perlakukan sebagai rahasia, jangan dibagikan.
- Jangan mencoba melewati challenge CF/WAF (bukan tujuan; pakai sesi asli saja).
