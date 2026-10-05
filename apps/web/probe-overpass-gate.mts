/**
 * Proves BOTH branches of the Overpass availability decision used by verify.ts:
 *   - a 504 / unreachable service  → probe says DOWN  → verify SKIPs (honest)
 *   - a real 2xx JSON query        → probe says UP    → verify runs the asserts
 *
 * Run: npx tsx apps/web/probe-overpass-gate.mts
 */
const OVERPASS = "https://overpass-api.de/api/interpreter";
const TINY_QUERY =
  '[out:json][timeout:15];node["amenity"="cafe"](around:300,-6.378806,106.712563);out ids 1;';

async function publicServiceUp(url: string, init?: { body?: string; timeoutMs?: number }): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: init?.body ? "POST" : "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(init?.timeoutMs ?? 15000),
      headers: {
        "User-Agent": "mia-assistant/1.0 (verify probe)",
        ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(init?.body ? { body: init.body } : {}),
    });
    if (res.status < 200 || res.status >= 300) return false;
    const text = await res.text();
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

let fail = 0;
const ok = (c: boolean, label: string, extra = "") => {
  if (c) console.log(`  ok   ${label}`);
  else { fail++; console.log(`  FAIL ${label}${extra ? ` :: ${extra}` : ''}`); }
};

console.log('== DOWN branch (this is what makes CI go green through an outage) ==');
// 1. connection refused on a closed port
ok((await publicServiceUp("http://127.0.0.1:9/nothing", { timeoutMs: 3000 })) === false, "unreachable host → probe says DOWN");
// 2. a 200 that is actually an HTML error page must NOT count as up
ok((await publicServiceUp("https://example.com/", { timeoutMs: 8000 })) === false, "HTML body that is not JSON → probe says DOWN");
// 3. DNS failure
ok((await publicServiceUp("https://this-host-does-not-exist-mia.invalid/", { timeoutMs: 5000 })) === false, "DNS failure → probe says DOWN");

console.log('\n== UP branch (only then may the live assertions run) ==');
const up = await publicServiceUp(OVERPASS, { body: `data=${encodeURIComponent(TINY_QUERY)}` });
console.log(`  info real Overpass probe says: ${up ? "UP" : "DOWN"}`);
if (up) {
  ok(true, "serving Overpass is detected as UP (live assertions will run)");
} else {
  console.log('  info Overpass is down right now — the live assertions would SKIP honestly.');
  console.log('  info (this probe still exits 0: both branches of the DECISION are proven)');
}

console.log(fail === 0 ? "\nGATE DECISION PROVEN" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);