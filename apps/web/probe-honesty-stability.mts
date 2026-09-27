// Stability scorecard for the honesty layer. Prints the two error classes
// separately, because "N/N passed" hides which kind of failure you have.
import { CORPUS, evaluateHonestyStack, scoreCorpus } from "./src/lib/honestyStability";

const card = scoreCorpus();
for (const f of CORPUS) {
  const r = evaluateHonestyStack(f);
  // The verdict MUST use the accusation/caveat split, not "did any note
  // appear". An honest turn is ALLOWED to attract an informative caveat
  // (e.g. "the report is host-scoped, not /login") — that is the layer doing
  // its job, not a false accusation. This probe previously judged on
  // `r.notes.length`, so every legit caveat read as a failure and the
  // per-fixture ✗/✓ lines contradicted scoreCorpus's own numbers.
  const accused = r.kinds.includes("accusation");
  const want = f.honest ? "diam" : "FIRE";
  const got = accused
    ? `tuduhan: ${r.sources.filter((_, i) => r.kinds[i] === "accusation").join(",")}`
    : r.notes.length
      ? `caveat: ${r.sources.join(",")}`
      : "diam";
  const ok = f.honest ? !accused : accused;
  console.log(`${ok ? "✓" : "✗"} ${want.padEnd(4)} got=${got.padEnd(34)} ${f.id}`);
  if (!ok) console.log(`      ${f.note ?? ""}`);
}
console.log("");
console.log(`benar            : ${card.correct}/${card.total}`);
console.log(`TUDUHAN SALAH    : ${card.falseAccusations.length}  ${card.falseAccusations.map((x) => x.id + "[" + x.sources + "]").join(" ")}`);
console.log(`FABRIKASI LOLOS  : ${card.missedFabrications.length}  ${card.missedFabrications.map((x) => x.id).join(" ")}`);
console.log(`caveat benar     : ${card.honestCaveats.length}  ${card.honestCaveats.map((x) => x.id + "[" + x.sources + "]").join(" ")}`);
console.log("");
console.log("setiap note yang diklasifikasi (audit manual klasifikasi):");
for (const f of CORPUS) {
  const r = evaluateHonestyStack(f);
  r.notes.forEach((n, i) => console.log(`  ${r.kinds[i].padEnd(10)} ${f.id}: ${n.trim().slice(0, 96)}`));
}
console.log("");
console.log("per guard (menyala / pada turn jujur / pada turn palsu):");
for (const [src, s] of Object.entries(card.bySource).sort((a, b) => b[1].fired - a[1].fired)) {
  const flag = card.factDependentCatches.some((c) => c.source === src) ? "  [fact-dependent]" : "";
  console.log(`  ${src.padEnd(20)} ${s.fired}  ${s.onHonest}  ${s.onDishonest}${flag}`);
}
console.log("");
console.log("catch dari guard fact-dependent (detector terbukti, fakta belum tentu ada di produksi):");
if (!card.factDependentCatches.length) console.log("  (tidak ada)");
for (const c of card.factDependentCatches)
  console.log(`  ${c.id} [${c.source}] ← ${c.fact}${c.supplied ? " (fakta ada di fixture)" : "  ⚠ FAKTA KOSONG"}`);
console.log(
  "\n⚠️ catch di daftar ini membuktikan DETECTOR-nya benar, BUKAN guard-nya hidup di produksi."
);
console.log("   Cek-fact-source yang sebenarnya: npx tsx apps/web/probe-guard-liveness.mts");
if (card.catchesWithoutTheirFact.length) {
  console.log(
    `\n✗ KONTRADIKSI: ${card.catchesWithoutTheirFact.length} catch tanpa fakta — guard fakt-fed menuduh dengan fact source kosong:`
  );
  for (const c of card.catchesWithoutTheirFact) console.log(`    ${c.id} [${c.source}] ← ${c.fact}`);
}
process.exit(
  card.falseAccusations.length === 0 &&
    card.missedFabrications.length === 0 &&
    card.catchesWithoutTheirFact.length === 0
    ? 0
    : 1
);
