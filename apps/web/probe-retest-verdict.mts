// Probe (READ-ONLY, does not touch src/): does retestVerdict report "patched"
// for a case that was never asserted and simply errored/moved?
// Claim under test: a no-assertion case returning non-2xx is NOT evidence of safety.
import { retestVerdict } from "./src/lib/retest";

const NO_ASSERT: any = { expect_contains: "", expect_status: 0 };
const WITH_SIGNATURE: any = { expect_contains: "leaked secret", expect_status: 200 };

const rows: Array<[string, any, any]> = [
  ["no-assertion  + 200 (signature gone?)", NO_ASSERT, { status: 200, body: "" }],
  ["no-assertion  + 404 (endpoint moved?)", NO_ASSERT, { status: 404, body: "" }],
  ["no-assertion  + 403 (auth gate?)     ", NO_ASSERT, { status: 403, body: "" }],
  ["no-assertion  + 500 (server broke?)  ", NO_ASSERT, { status: 500, body: "" }],
  ["no-assertion  + 301 (redirect?)      ", NO_ASSERT, { status: 301, body: "" }],
  ["with-signature + 200 & sig ABSENT   ", WITH_SIGNATURE, { status: 200, body: "clean now" }],
  ["with-signature + 200 & sig PRESENT   ", WITH_SIGNATURE, { status: 200, body: "here: leaked secret" }],
  ["with-signature + 404                 ", WITH_SIGNATURE, { status: 404, body: "" }],
];

let suspect = 0;
for (const [label, c, r] of rows) {
  const v = retestVerdict(c, r);
  // "patched" is the verdict that becomes "sudah dipatch" and, if wired to
  // brainRecordSafe, "sudah dites aman — jangan ulang buta".
  const dangerous = v === "patched" && !c.expect_contains && !c.expect_status;
  if (dangerous) suspect++;
  console.log(
    `${dangerous ? "⚠️ " : "   "}${label}  →  ${v.toUpperCase()}` +
      (dangerous ? "   ← klaim 'aman/patched' dari case yang TIDAK punya assertion" : "")
  );
}

console.log("");
console.log(`verdict 'patched' dari case tanpa assertion: ${suspect} kasus`);
console.log(suspect > 0
  ? "→ TEMUAN: retestRun bisa melaporkan 🟢 'sudah dipatch' untuk 404/403/500. Itu klaim keamanan palsu."
  : "→ aman: tidak ada klaim patched dari case tanpa assertion.");
console.log(`PROBE_EXIT=${suspect > 0 ? 1 : 0}`);
