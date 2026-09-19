// Audit probe #2: deeper edge cases — prefix-collision, headless deny, scope, regex robustness.
import fs from "node:fs";
for (const l of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { executeTool } = await import("./src/lib/tools");
const u = "audit_superpowers_probe";
const p = (name: string, args: Record<string, unknown> = {}) => executeTool({ id: "a2", name, arguments: JSON.stringify(args) }, u);

// A. dom_taint regex: sink dengan variable bersama + sanitizer window
const dt1 = await p("dom_taint", { text: "const a = location.hash;\nconst b = a;\neval(b);" });
console.log("A taint var-chain (expect eval flagged):", /eval/.test(dt1) ? "FLAGGED" : "MISSED");
const dt2 = await p("dom_taint", { text: "const a = location.hash;\nconst safe = encodeURIComponent(a);\neval(safe);" });
console.log("A sanitizer-diff-var (expect flagged, known FP):", /eval/.test(dt2) ? "FLAGGED" : "MISSED");

// B. target_brain host collision: subdomain vs host sharing
const { brainRecordEndpoints, brainBrief, brainForget } = await import("./src/lib/targetBrain");
brainRecordEndpoints(u, "https://api.example.com", ["/v1/x"]);
brainRecordEndpoints(u, "https://example.com", ["/web/y"]);
const b1 = brainBrief(u, "https://example.com/page");
const b2 = brainBrief(u, "https://api.example.com/v1/x");
console.log("B brain isolation (main host must NOT list /v1/x):", !/\/v1\/x/.test(b1) ? "OK" : "LEAK");
console.log("B brain isolation (api host lists /v1/x):", /\/v1\/x/.test(b2) ? "OK" : "MISSING");
brainForget(u, "https://example.com");
brainForget(u, "https://api.example.com");

// C. retest: target filter pakai URL penuh (bukan host saja)
const { retestSave, retestRun, retestListText } = await import("./src/lib/retest");
const c = retestSave(u, { title: "t", url: "https://example.com/x", expect_contains: "zzz" });
const runT = await retestRun(u, { target: "https://example.com" });
console.log("C retest target=url-penuh:", /t —/.test(runT) ? "OK" : "BROKEN");
console.log("C retest list target=url-penuh:", /R-/.test(retestListText(u, { target: "https://example.com" })) ? "OK" : "BROKEN");

// D. headless deny: retest_run/auth_matrix/dom_taint auto-denied di turn automation?
const { isHeadlessSideEffect } = await import("./src/lib/agent");
for (const t of ["retest_run", "retest_add", "auth_matrix", "dom_taint", "content_discover"]) {
  console.log("D headless-deny", t, ":", isHeadlessSideEffect(t) ? "DENIED" : "ALLOWED");
}
