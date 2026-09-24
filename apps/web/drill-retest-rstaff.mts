// One-shot retest drill: buktikan case R-staff (auto-created dari finding_add)
// bekerja dua arah:
//   1. retest_run id=R-staff… → 🔴 MASIH RENTAN (lab belum dipatch)
//   2. case demo-temp dengan signature mustahil → 🟢 sudah dipatch (cabang
//      verdict kedua teruji), lalu case temp dihapus dari store.
// Dispatch via executeTool (jalur agent); audit log + output jadi bukti.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !m[1].startsWith("NEXT_PUBLIC")) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { executeTool } = await import("./src/lib/tools");
const USER = "naufalazhar652952";
const BASE = "https://cozy-kangaroo-42f2e0.netlify.app";
const DOC = `${BASE}/api/dokumen?id=4`;
const RETEST_FILE = join(here, ".data/users/naufalazhar652952/retest.json");

const mk = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) });

(async () => {
  let fail = false;

  // ── 1) Case asli R-staff → harus 🔴 MASIH RENTAN (lab belum dipatch) ──
  console.log("── retest_run id=R-staff… (harap 🔴) ──");
  const r1 = await executeTool(mk("rr1", "retest_run", { id: "R-staff-dapat-membaca-dokumen-internal-rah" }), USER);
  console.log(r1.slice(0, 500));
  const red = /🔴/.test(r1) && /MASIH RENTAN/.test(r1);
  console.log("verdict 🔴 MASIH RENTAN:", red ? "OK ✓" : "✗ GAGAL");
  if (!red) fail = true;

  // ── 2) Case demo-temp: signature mustahil → harus 🟢 sudah dipatch ──
  console.log("\n── retest_add case demo-temp (signature mustahil) ──");
  const ra = await executeTool(mk("ra1", "retest_add", {
    title: "DEMO temp — patched-branch verification (auto-removed)",
    url: DOC,
    method: "GET",
    session: "staff",
    expect_status: 200,
    expect_contains: "SIGNATURE-DEMO-TIDAK-AKAN-ADA-DI-RESPONS-7f3a",
    finding_id: "F-muebsh58-a0f4",
  }), USER);
  console.log(ra.slice(0, 300));
  const demoId = (ra.match(/R-[a-z0-9-]+/i) || [])[0];

  if (demoId) {
    console.log(`\n── retest_run id=${demoId} (harap 🟢) ──`);
    const r2 = await executeTool(mk("rr2", "retest_run", { id: demoId }), USER);
    console.log(r2.slice(0, 400));
    const green = /🟢/.test(r2) && /sudah dipatch/i.test(r2);
    console.log("verdict 🟢 sudah dipatch:", green ? "OK ✓ (cabang patched terbukti)" : "✗ GAGAL");
    if (!green) fail = true;

    // cleanup: hapus case demo-temp dari store
    if (existsSync(RETEST_FILE)) {
      const raw = JSON.parse(readFileSync(RETEST_FILE, "utf8"));
      const arr = Array.isArray(raw) ? raw : raw.cases;
      if (Array.isArray(arr)) {
        const kept = arr.filter((c: { id?: string }) => c.id !== demoId);
        if (Array.isArray(raw)) writeFileSync(RETEST_FILE, JSON.stringify(kept, null, 2));
        else writeFileSync(RETEST_FILE, JSON.stringify({ ...raw, cases: kept }, null, 2));
        console.log("\ncleanup: case demo-temp dihapus dari retest.json ✓");
      }
    }
  } else {
    console.log("✗ id case demo-temp tidak terbaca — cabang 🟢 tidak teruji");
    fail = true;
  }

  console.log("\nRESULT:", fail ? "FAIL" : "PASS — retest dua arah terbukti");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
