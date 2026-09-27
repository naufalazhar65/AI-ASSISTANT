/**
 * LIVE TEST — does the content_discover/js_mine → brainRecordEndpoints wiring
 * (tools.ts:4576 / :4652) actually reach target-brain.json, and does that make
 * the surface-coverage guard (untestedSurfaceClaimNote) live in production?
 *
 * 2026-09-27: 29x js_mine + 17x content_discover in the audit log and the
 * owner's target-brain.json still had endpoints: [] — the guard was DEAD while
 * the corpus scored it as passing. This proves the fact source, then the guard.
 *
 * Runs against the REAL lab (owner's authorised PENTEST_LAB_TARGETS) via
 * executeTool — the same dispatch the agent uses — on a throwaway user, so the
 * owner's own brain is not polluted with a test run.
 */
import { executeTool } from "./src/lib/tools";
import { untestedSurfaceClaimNote } from "./src/lib/claimAudit";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./src/lib/users";

const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const U = `verify_wire_${Date.now()}`;
const brainPath = join(userDataRoot(), U, "target-brain.json");

let fail = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) fail++;
};

console.log(`user uji: ${U}`);
console.log(`lab    : ${LAB}\n`);

// 1. Fact source starts empty — this is the production condition that killed it.
console.log("1. kondisi awal (seperti produksi: endpoints kosong)");
// Shape verified against the real file (2026-09-27): the store is
// { "<host>": { host, tech, authModel, endpoints: [{path, params, …}] } }.
// An earlier version of THIS probe assumed { host: { targets: [ … ] } } and
// reported endpoints = 0 on a wiring that was in fact working — a false
// negative against my own code. Read the real shape, don't guess it.
function endpointsOf(file: string): string[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, { endpoints?: Array<{ path: string }> }>;
  return Object.values(raw).flatMap((t) => (t?.endpoints ?? []).map((e) => e.path));
}
ok(endpointsOf(brainPath).length === 0, "endpoints awal kosong (kondisi produksi yang membunuh guard)");

// 2. Run the two tools that should now feed the brain.
console.log("\n2. jalankan tool lewat dispatch yang sama dengan agent");
for (const [name, args] of [
  ["content_discover", { url: LAB }],
  ["js_mine", { url: LAB }],
] as const) {
  const out = await executeTool(
    { id: `t-${name}`, name, arguments: JSON.stringify(args) } as never,
    U
  );
  const text = String(out);
  const dead = /Error:|SCOPE|ditolak/i.test(text.slice(0, 400));
  const bullets = (text.match(/^•\s\/.*$/gm) || []).length;
  ok(!dead, `${name} selesai tanpa error/penolakan scope`);
  console.log(`     ↳ baris "• /path" di output: ${bullets}`);
}

// 3. Did the brain actually receive endpoints?
console.log("\n3. fact source setelah wiring");
ok(existsSync(brainPath), "target-brain.json dibuat");
const eps = endpointsOf(brainPath);
ok(eps.length > 0, `endpoints tercatat = ${eps.length}`);
console.log(`     ↳ contoh: ${eps.slice(0, 5).join(", ") || "(tidak ada)"}`);

// 4. The guard the whole thing exists for.
console.log("\n4. guard surface-coverage dengan fakta NYATA");
const facts = { endpointsSeen: eps.length, endpointsProbed: 0, findingsTotal: 0, findingsWithProof: 0 } as never;
const falseClaim = "Semua endpoint utama juga sudah aku cek berulang supaya hasilnya konsisten.";
const note = untestedSurfaceClaimNote(falseClaim, facts);
ok(!!note, `guard menyala pada klaim-butuh + facts(endpointsSeen=${eps.length}, probed=0)`);
console.log(`     ↳ ${note.slice(0, 120)}`);

// 5. And it must still stay silent when the probe count really does cover them.
const covered = untestedSurfaceClaimNote("Semua endpoint utama sudah dicek.", {
  ...(facts as any),
  endpointsProbed: eps.length,
} as never);
ok(!covered, "guard diam saat probed benar-benar menutup semua endpoint (anti tuduhan salah)");

// cleanup — never leave a scratch user behind
try {
  rmSync(join(userDataRoot(), U), { recursive: true, force: true });
  ok(!existsSync(join(userDataRoot(), U)), "user uji dibersihkan");
} catch (e) {
  ok(false, `bersihkan gagal: ${e instanceof Error ? e.message : e}`);
}

console.log(`\nEXIT=${fail ? 1 : 0}`);
process.exit(fail ? 1 : 0);
