// Two-way behaviour probe for the 2026-09-27 fixes. Every row states whether the
// detector MUST or MUST NOT fire — a detector that fires on the "no" rows is a
// false-accusation machine, which is the error class the corpus exists to catch.
import { absenceSafetyClaim, hasCompletionClaim } from "./src/lib/agent";

let fail = 0;
const row = (name: string, got: boolean, want: boolean) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "OK  " : "FAIL"}  ${name.padEnd(52)} got=${String(got).padEnd(5)} want=${want}`);
};

console.log("=== absenceSafetyClaim: harus MENYALA (klaim keamanan) ===");
for (const s of [
  "tidak ada celah yang terlihat di halaman ini",
  "nggak ditemukan kerentanan tambahan",
  "sudah aman dari SQL injection",
  "endpoint ini aman dari XSS",
  "tidak rentan terhadap IDOR",
  "vuln-nya bersih",
  "tidak ditemukan vuln baru",
]) row(JSON.stringify(s).slice(0, 50), absenceSafetyClaim(s), true);

console.log("\n=== absenceSafetyClaim: HARUS DIAM (prosa biasa) ===");
for (const s of [
  "instalasi ini aman dipakai besok",
  "server host-nya bersih",
  "aman",
  "bersih",
  "aman dari",
  "target ini bersih dari error",
  "kamu aman ya hari ini",
  "pemasangan sudah beres dan bersih",
  "aman-aman saja kok",
]) row(JSON.stringify(s).slice(0, 50), absenceSafetyClaim(s), false);

console.log("\n=== hasCompletionClaim: harus MENYALA ===");
for (const s of [
  "pentest menyeluruh untuk lab tersebut sudah selesai",
  "pengujian menyeluruh di target ini sudah selesai",
  "full pentest sudah selesai",
  "pengujian sudah selesai",
  "scan endpoint selesai semua",
  "audit keamanan sudah tuntas",
]) row(JSON.stringify(s).slice(0, 50), hasCompletionClaim(s), true);

console.log("\n=== hasCompletionClaim: HARUS DIAM (jujur) ===");
for (const s of [
  "pengujian belum selesai",
  "aku belum menguji /login",
  "belum ada yang selesai dites",
  "sudah kupentest sebelumnya",
  "temuannya 7, sudah aku rangkum di PDF",
]) row(JSON.stringify(s).slice(0, 50), hasCompletionClaim(s), false);

console.log(`\n${fail === 0 ? "SEMUA DUA ARAH LULUS" : `${fail} BARIS GAGAL`}`);
process.exit(fail === 0 ? 0 : 1);
