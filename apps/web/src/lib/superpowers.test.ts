import { describe, it, expect } from "vitest";
import { brainHost, brainPathKey, brainPath, brainParamNames } from "./targetBrain";
import { chainSummary } from "./bounty";
import { retestCaseId, retestHost, retestVerdict } from "./retest";
import { parseMatrixSpec, matrixGranted, matrixSame, matrixFindings } from "./authMatrix";
import { analyzeTaint, escapeRegExp, TAINT_SOURCES, TAINT_SINKS } from "./domTaint";
import { learnClassify, learnTech, learnEndpointStyle, learnExtract, isPrivateIp } from "./learning";
import { pdfDeliverableSuffix, chainRunClaimSuffix, lastInstructionText, reportTargetFromMessages, turnRanTool, type ChatMessage } from "./agent";
import { parseChainList } from "./exploitChains";

describe("targetBrain pure helpers", () => {
  it("brainHost extracts hostname from url/host forms", () => {
    expect(brainHost("https://lab.example.com/api/x?id=1")).toBe("lab.example.com");
    expect(brainHost("LAB.Example.com")).toBe("lab.example.com");
    expect(brainHost("http://127.0.0.1:4010/x")).toBe("127.0.0.1");
    expect(brainHost("")).toBe("");
    expect(brainHost("not a url ??")).toBe("");
  });

  it("brainPathKey keeps path + sorted param names only", () => {
    expect(brainPathKey("https://x.tld/api/dokumen?id=2&sort=asc")).toBe("/api/dokumen?id&sort");
    expect(brainPathKey("https://x.tld/page")).toBe("/page");
    expect(brainPathKey("junk")).toBe("");
  });

  it("brainPath strips the origin from absolute URLs (host never leaks into the stored path)", () => {
    expect(brainPath("https://lab.example.com/api/dokumen?id=1")).toBe("/api/dokumen?id=1");
    expect(brainPath("https://LAB.example.com:8443/api/x")).toBe("/api/x");
    expect(brainPath("/api/orders")).toBe("/api/orders");
    expect(brainPath("api/dokumen?id=1")).toBe("/api/dokumen?id=1");
    expect(brainPath("")).toBe("");
  });

  it("brainParamNames returns sorted unique query keys", () => {
    expect(brainParamNames("https://x.tld/p?b=1&a=2&b=3")).toEqual(["a", "b"]);
    expect(brainParamNames("https://x.tld/p")).toEqual([]);
  });

  it("coverageTried maps text to attack classes (audit 2026-09-23+)", async () => {
    const { coverageTried, brainCoverage, brainRecordEndpoints, brainRecordProof } = await import("./targetBrain");
    expect([...coverageTried("BOLA /api/dokumen?id + poc_verify STABIL")].sort()).toEqual(["idor"]);
    expect([...coverageTried("halo apa kabar")]).toEqual([]);
    // Integration: endpoints + proof + finding → tried shown, rest are gaps.
    const u = "verify_coverage_tmp";
    brainRecordEndpoints(u, "https://cov.tld", ["/api/dokumen?id=1", "/page"]);
    brainRecordProof(u, "https://cov.tld", { what: "BOLA /api/dokumen", how: "bola_diff A/B", severity: "high", findingId: "F-1" });
    const { addFinding } = await import("./security");
    addFinding(u, { title: "Stored XSS pengaduan", severity: "medium", target: "https://cov.tld/api/pengaduan", evidence: "payload ter-reflect" });
    const out = await brainCoverage(u, "cov.tld");
    expect(out).toContain("IDOR/BOLA");
    expect(out).toContain("XSS");
    expect(out).toContain("Gap");
    expect(out).toContain("SSRF");
    const empty = await brainCoverage(u, "unknown.tld");
    expect(empty).toContain("kosong");
    const fs = await import("node:fs");
    fs.rmSync(`apps/web/.data/users/${u}`, { recursive: true, force: true });
  });
});

describe("retest suite helpers", () => {
  it("retestCaseId is stable and slug-safe", () => {
    const a = retestCaseId("BOLA /api/dokumen", "https://x.tld/api/dokumen?id=1");
    const b = retestCaseId("BOLA /api/dokumen", "https://x.tld/api/dokumen?id=1");
    expect(a).toBe(b);
    expect(a.startsWith("R-")).toBe(true);
    expect(a).not.toMatch(/[^A-Za-z0-9-]/);
  });

  it("retestHost extracts host", () => {
    expect(retestHost("https://a.b.tld/x")).toBe("a.b.tld");
    expect(retestHost("bad")).toBe("");
  });

  it("retestVerdict: vulnerable when signature matches, patched when not, error on fetch error", () => {
    const c = { expect_contains: "secret-doc", expect_status: 200 };
    expect(retestVerdict(c, { status: 200, body: "…Secret-Doc here…" })).toBe("vulnerable");
    expect(retestVerdict(c, { status: 403, body: "forbidden" })).toBe("patched");
    expect(retestVerdict(c, { status: 200, body: "other data" })).toBe("patched");
    expect(retestVerdict(c, { status: 0, body: "", error: "ECONNREFUSED" })).toBe("error");
    // no assertions → 2xx counts as still-vulnerable signal
    expect(retestVerdict({ expect_contains: "", expect_status: 0 }, { status: 200, body: "x" })).toBe("vulnerable");
    expect(retestVerdict({ expect_contains: "", expect_status: 0 }, { status: 500, body: "x" })).toBe("patched");
  });
});

describe("auth matrix helpers", () => {
  it("parseMatrixSpec validates lists and bounds", () => {
    const ok = parseMatrixSpec({ endpoints: "/a,/b", sessions: "admin, user", granted_status_max: "399" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.spec.endpoints).toEqual(["/a", "/b"]);
      expect(ok.spec.sessions).toEqual(["admin", "user"]);
      expect(ok.spec.grantedStatusMax).toBe(399);
    }
    expect(parseMatrixSpec({ endpoints: "", sessions: "a" }).ok).toBe(false);
    expect(parseMatrixSpec({ endpoints: "/a", sessions: "" }).ok).toBe(false);
    expect(parseMatrixSpec({ endpoints: "/a", sessions: "a", granted_status_max: 999 }).ok).toBe(false);
  });

  it("matrixGranted treats errors as denied and honors the granted ceiling", () => {
    expect(matrixGranted({ status: 200, error: undefined }, 399)).toBe(true);
    expect(matrixGranted({ status: 403, error: undefined }, 399)).toBe(false);
    expect(matrixGranted({ status: 302, error: undefined }, 200)).toBe(false);
    expect(matrixGranted({ status: 0, error: "boom" }, 399)).toBe(false);
  });

  it("matrixSame compares status and body size with tolerance", () => {
    expect(matrixSame({ status: 200, len: 1000, digest: "" }, { status: 200, len: 1005, digest: "" })).toBe(true);
    expect(matrixSame({ status: 200, len: 1000, digest: "" }, { status: 200, len: 2000, digest: "" })).toBe(false);
    expect(matrixSame({ status: 200, len: 1000, digest: "" }, { status: 404, len: 1000, digest: "" })).toBe(false);
  });

  it("matrixSame does not claim 'same data' for same-size DIFFERENT content", () => {
    // Same status + near-identical length but different content (e.g. 200 login
    // page vs 200 full data) — not a cross-role signal. digest carries the body.
    const data = { status: 200, len: 1024, digest: "1024:12345" };
    const login = { status: 200, len: 1024, digest: "1024:99999" };
    expect(matrixSame(data, login)).toBe(false);
    // Genuinely identical responses still match.
    expect(matrixSame(data, { status: 200, len: 1024, digest: "1024:12345" })).toBe(true);
    // Row without digest (legacy) keeps the old length-only behavior.
    expect(matrixSame({ status: 200, len: 1024, digest: "" }, login)).toBe(true);
  });

  it("matrixSame requires digest equality at any in-tolerance size gap (audit 2026-09-23)", () => {
    // 100 B gap within 5% tolerance but different content — was "same" (FP).
    expect(matrixSame({ status: 200, len: 2000, digest: "2000:aaaa" }, { status: 200, len: 2100, digest: "2100:bbbb" })).toBe(false);
    expect(matrixSame({ status: 200, len: 2000, digest: "2000:aaaa" }, { status: 200, len: 2100, digest: "2000:aaaa" })).toBe(true);
  });

  it("matrix default granted ceiling is 2xx (302-to-login is not access)", () => {
    const spec = parseMatrixSpec({ endpoints: "/a", sessions: "admin" });
    expect(spec.ok && spec.spec.grantedStatusMax).toBe(299);
    expect(matrixGranted({ status: 302, error: undefined }, 299)).toBe(false);
    expect(matrixGranted({ status: 200, error: undefined }, 299)).toBe(true);
  });

  it("isPrivateIp denies loopback/RFC1918/link-local/metadata, allows public (audit 2026-09-23)", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "localhost", "224.0.0.1", "999.1.1.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2606:4700:4700::1111"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
    // Hostnames are not our call (DNS decides) — never blanket-deny.
    expect(isPrivateIp("example.com")).toBe(false);
  });

  it("escapeRegExp neutralizes $ in identifiers (audit 2026-09-23)", () => {
    expect(escapeRegExp("$x")).toBe("\\$x");
    // \b can never precede `$` (non-word char) — callers use lookarounds.
    expect(new RegExp(`(?<![\\w$])${escapeRegExp("$x")}(?![\\w$])`).test("a = $x;")).toBe(true);
    expect(new RegExp(`(?<![\\w$])${escapeRegExp("$x")}(?![\\w$])`).test("a = $xy;")).toBe(false);
  });

  it("tracks $-prefixed variables source→sink (audit 2026-09-23)", () => {
    const flows = analyzeTaint(`const $x = location.hash;\ndocument.body.innerHTML = $x;`, "app.js");
    expect(flows.length).toBe(1);
    expect(flows[0].variable).toBe("$x");
    expect(flows[0].sanitized).toBe(false);
  });

  it("brainRecordEndpoints stores names-only query (no secret values)", async () => {
    const { brainRecordEndpoints, brainBrief } = await import("./targetBrain");
    const u = "audit_brain_values";
    brainRecordEndpoints(u, "https://lab.tld", ["/api/dokumen?token=abc123&id=7"]);
    const brief = brainBrief(u, "lab.tld");
    expect(brief).toContain("token");
    expect(brief).not.toContain("abc123");
    const { brainForget } = await import("./targetBrain");
    brainForget(u, "lab.tld");
  });

  it("matrixFindings flags anonymous-access and cross-role, not uniform", () => {
    const spec = { endpoints: ["/api/dokumen?id=1", "/safe"], sessions: ["admin", "guest"] };
    const rows = [
      { endpoint: "/api/dokumen?id=1", session: "", status: 200, len: 500, digest: "" },
      { endpoint: "/api/dokumen?id=1", session: "admin", status: 200, len: 500, digest: "" },
      { endpoint: "/api/dokumen?id=1", session: "guest", status: 200, len: 505, digest: "" },
      { endpoint: "/safe", session: "", status: 403, len: 10, digest: "" },
      { endpoint: "/safe", session: "admin", status: 200, len: 100, digest: "" },
      { endpoint: "/safe", session: "guest", status: 403, len: 10, digest: "" },
    ];
    const f = matrixFindings(spec, rows);
    const dokumen = f.find((x) => x.endpoint === "/api/dokumen?id=1");
    expect(dokumen?.kind).toBe("anonymous-access");
    expect(f.some((x) => x.endpoint === "/api/dokumen?id=1" && x.kind === "cross-role")).toBe(true);
    const safe = f.find((x) => x.endpoint === "/safe");
    expect(safe?.kind).toBe("uniform");
    expect(safe?.severity).toBe("info");
  });
});

describe("dom taint analysis", () => {
  it("has sources and sinks defined", () => {
    expect(TAINT_SOURCES.length).toBeGreaterThan(4);
    expect(TAINT_SINKS.length).toBeGreaterThan(4);
  });

  it("flags unsanitized source→sink flow", () => {
    const js = `
      const q = location.hash.slice(1);
      document.getElementById("out").innerHTML = q;
    `;
    const flows = analyzeTaint(js, "app.js");
    expect(flows.length).toBe(1);
    expect(flows[0].source).toBe("location.hash");
    expect(flows[0].sink).toBe("innerHTML");
    expect(flows[0].sanitized).toBe(false);
  });

  it("does not flag sanitized flow or unrelated sinks", () => {
    const clean = "const q = encodeURIComponent(location.hash.slice(1));\n      el.textContent = q;";
    expect(analyzeTaint(clean, "clean.js").length).toBe(0);
    const noSink = "const q = location.hash;\n      console.log(q);";
    expect(analyzeTaint(noSink, "nosink.js").length).toBe(0);
  });

  it("flags eval on postMessage data (classic bypass)", () => {
    const js = 'window.addEventListener("message", (e) => {\n        const cmd = e.data;\n        eval(cmd);\n      });';
    const flows = analyzeTaint(js, "m.js");
    expect(flows.some((f) => f.sink === "eval" && f.variable === "cmd")).toBe(true);
  });
});

describe("disclosed-report learning", () => {
  it("classifies vuln class from text", () => {
    expect(learnClassify("IDOR in /api/v1/orders allowed me to read other users' orders")).toBe("idor");
    expect(learnClassify("Blind SSRF via the import feature")).toBe("ssrf");
    expect(learnClassify("JWT alg none authentication bypass")).toBe("jwt");
    expect(learnClassify("nothing special here")).toBe("info-disclosure");
  });

  it("extracts tech and endpoint style", () => {
    expect(learnTech("the Laravel app leaked env via nextjs page")).toContain("laravel");
    expect(learnEndpointStyle("found at /api/v2/users/9821 leaking email")).toBe("/api/v2/users/9821");
  });

  it("learnExtract builds a bounded pattern", () => {
    const p = learnExtract("Broken Object Level Authorization on /api/orders\nBypass: changed the id param to another tenant's id. Impact: full data read.", "https://example.com/writeup");
    expect(p).not.toBeNull();
    if (p) {
      expect(p.vulnClass).toBe("bola");
      expect(p.endpointStyle).toContain("/api/orders");
      expect(p.source).toBe("https://example.com/writeup");
      expect(p.trick.length).toBeGreaterThan(0);
    }
  });

  it("learnExtract rejects tiny texts", () => {
    expect(learnExtract("too short", "x")).toBeNull();
  });
});

describe("bounty auto_chain summary (one-line honest verdict)", () => {
  it("prefers the verdict line + finding count, never the duplicated header", () => {
    const out = `⛓️ https://host (idor)\nstatus: 200 OK\n\n• baseline GET: 200\n🔴 3 potensi IDOR ditemukan!\n📋 FINDINGS SIAP REPORT (3)\n⚠️ SEMUA finding perlu verifikasi manual sebelum finding_add`;
    const s = chainSummary(out);
    expect(s).toBe("🔴 3 potensi IDOR ditemukan! · 3 finding (belum diverifikasi)");
    expect(s).not.toContain("⛓️ https://host (idor)");
  });

  it("reports an all-clear chain honestly", () => {
    const out = `⛓️ https://host (ssrf)\n\n• param_discover: ?id=1\n✅ Tidak ada indikasi SSRF\n🚨 SIGNALS (0)`;
    const s = chainSummary(out);
    expect(s).toBe("✅ Tidak ada indikasi SSRF · 0 sinyal");
  });

  it("falls back to the first non-empty line", () => {
    expect(chainSummary("")).toBe("");
    expect(chainSummary("only line")).toBe("only line");
  });

  it("reports a STRUCTURALLY SKIPPED chain as not-run, never as the header", () => {
    const out = `⛓️ EXPLOIT CHAIN: IDOR — http://host\n0 langkah dijalankan — 3ms\n\n⛔ CHAIN TIDAK DIJALANKAN: BOLA/IDOR butuh 2 sesi (akun berbeda) untuk diff — pasar session_a & session_b.\nContoh: ...`;
    const s = chainSummary(out);
    expect(s).toBe("⛔ CHAIN TIDAK DIJALANKAN: BOLA/IDOR butuh 2 sesi (akun berbeda) untuk diff — pasar session_a & session_b.");
    expect(s).not.toContain("⛓️ EXPLOIT CHAIN");
    expect(s).not.toMatch(/langkah dijalankan/);
  });

  it("surfaces the aggregate Ringkasan FIRST for comma-separated chain batches", () => {
    const out = `⛓️ EXPLOIT CHAIN (4): idor, auth_bypass, ssrf, session_fixation — http://host\n\n⛓️ EXPLOIT CHAIN: IDOR — http://host\n0 langkah dijalankan — 3ms\n\n⛔ CHAIN TIDAK DIJALANKAN: BOLA/IDOR butuh 2 sesi...\n\n⛓️ EXPLOIT CHAIN: AUTH_BYPASS — http://host\n0 langkah dijalankan — 2ms\n\n⛔ CHAIN TIDAK DIJALANKAN: butuh token JWT...\n\n━━ Ringkasan ━━\n0 chain dengan langkah nyata · 4 dilewati (butuh setup / tidak dikenal).\n⛔ TIDAK ADA chain yang benar-benar dijalankan — giliran ini belum menghasilkan pengujian baru.`;
    const s = chainSummary(out);
    expect(s).toContain("━━ Ringkasan ━━");
    expect(s).toContain("0 chain dengan langkah nyata");
    expect(s).toContain("TIDAK ADA chain yang benar-benar dijalankan");
    expect(s).not.toContain("⛓️ EXPLOIT CHAIN: IDOR");
  });
});

describe("parseChainList (comma-separated exploit chains)", () => {
  it("splits, trims, lowercases and drops empties", () => {
    expect(parseChainList("idor,auth_bypass, ssrf  ,session_fixation")).toEqual([
      "idor",
      "auth_bypass",
      "ssrf",
      "session_fixation",
    ]);
  });
  it("handles a single chain and empty input", () => {
    expect(parseChainList("ssrf")).toEqual(["ssrf"]);
    expect(parseChainList("")).toEqual([]);
    expect(parseChainList("  ,,")).toEqual([]);
  });
  it("keeps unknown tokens in place so they surface as honest skips", () => {
    expect(parseChainList("idor,bogus")).toEqual(["idor", "bogus"]);
  });
});

describe("chainRunClaimSuffix (no-chain-ran narration guard)", () => {
  const chainMsgs = (chainResult: string, userAsk = "full pentest di lab ini, lalu buatkan report pdfnya"): ChatMessage[] => [
    { role: "user", content: userAsk },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "exploit_chain", arguments: '{"chain":"idor,auth_bypass,ssrf,session_fixation","url":"http://host"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: chainResult },
  ];

  it("appends suffix when chain errored but reply claims ''sudah aku uji'' (the live slop)", () => {
    const out = `Error: chain "idor,auth_bypass,ssrf,session_fixation" tidak dikenal. Tersedia:\n• idor — ...`;
    const s = chainRunClaimSuffix(chainMsgs(out), "Sistemnya sudah aku uji dan laporannya juga udah selesai dicetak dalam format PDF");
    expect(s).toContain("TIDAK menjalankan satu chain pun");
    expect(s).toContain("error/skip");
    expect(s).toContain("SUDAH tercatat sebelumnya");
  });

  it("appends suffix when the aggregate said zero chains ran", () => {
    const out = "⛓️ EXPLOIT CHAIN (4): idor, auth_bypass, ssrf, session_fixation — http://host\n\n⛓️ EXPLOIT CHAIN: IDOR — http://host\n0 langkah dijalankan — 3ms\n\n━━ Ringkasan ━━\n0 chain dengan langkah nyata · 4 dilewati (butuh setup / tidak dikenal).\n⛔ TIDAK ADA chain yang benar-benar dijalankan — giliran ini belum menghasilkan pengujian baru.";
    const s = chainRunClaimSuffix(chainMsgs(out), "Oke, sistemnya sudah selesai diuji, PDF-nya keluar");
    expect(s).toContain("TIDAK menjalankan satu chain pun");
  });

  it("silent when the reply already admits the chain did not run", () => {
    const out = `Error: chain "bogus" tidak dikenal. Tersedia:\n• idor — ...`;
    const s = chainRunClaimSuffix(chainMsgs(out), "Ternyata chain-nya tidak dikenal, jadi belum bisa aku jalankan");
    expect(s).toBe("");
  });

  it("silent when chains actually ran steps (real work happened)", () => {
    const out = "⛓️ EXPLOIT CHAIN: SSRF — http://host\n4 langkah dijalankan — 812ms\n\n• param_discover: ?id=1\n✅ Tidak ada indikasi SSRF";
    const s = chainRunClaimSuffix(chainMsgs(out), "Sudah aku uji SSRF-nya, tidak ada callback");
    expect(s).toBe("");
  });

  it("silent when no exploit_chain result exists this turn", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "full pentest di lab ini ya" },
      { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function" as const, function: { name: "finding_list", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c", content: "1. stored XSS" },
    ];
    const s = chainRunClaimSuffix(msgs, "Sudah aku uji semua");
    expect(s).toBe("");
  });

  it("silent when the user never asked for pentest/exploit work", () => {
    const out = `Error: chain "x" tidak dikenal.`;
    const s = chainRunClaimSuffix(chainMsgs(out, "besok jemput aku jam 7"), "Oke sudah");
    expect(s).toBe("");
  });

  it("silent when the reply makes no success claim", () => {
    const out = `Error: chain "x" tidak dikenal.`;
    const s = chainRunClaimSuffix(chainMsgs(out), "Sabar ya, aku proses dulu");
    expect(s).toBe("");
  });

  it("silent on a MIXED batch where a sibling chain skipped but another really ran (Ringkasan '1 chain dengan langkah nyata')", () => {
    const out = "⛓️ EXPLOIT CHAIN (2): idor, ssrf — http://host\n\n⛓️ EXPLOIT CHAIN: IDOR — http://host\n0 langkah dijalankan — 3ms\n\n⛔ CHAIN TIDAK DIJALANKAN: BOLA/IDOR butuh 2 sesi (akun berbeda) untuk diff.\n\n⛓️ EXPLOIT CHAIN: SSRF — http://host\n4 langkah dijalankan — 812ms\n\n• param_discover: ?id=1\n✅ Tidak ada indikasi SSRF\n\n━━ Ringkasan ━━\n1 chain dengan langkah nyata · 1 dilewati (butuh setup / tidak dikenal).";
    const s = chainRunClaimSuffix(chainMsgs(out), "Selesai, full pentest sudah aku uji — tidak ada indikasi SSRF");
    expect(s).toBe("");
  });

  it("fires on a confirmation continuation — newest user message is a bare 'ya', real ask earlier — for an all-skip batch", () => {
    const out = "⛓️ EXPLOIT CHAIN (2): idor, auth_bypass — http://host\n\n⛓️ EXPLOIT CHAIN: IDOR — http://host\n0 langkah dijalankan — 2ms\n\n⛔ CHAIN TIDAK DIJALANKAN: butuh 2 sesi.\n\n⛓️ EXPLOIT CHAIN: AUTH_BYPASS — http://host\n0 langkah dijalankan — 2ms\n\n⛔ CHAIN TIDAK DIJALANKAN: butuh token JWT.\n\n━━ Ringkasan ━━\n0 chain dengan langkah nyata · 2 dilewati (butuh setup / tidak dikenal).\n⛔ TIDAK ADA chain yang benar-benar dijalankan — giliran ini belum menghasilkan pengujian baru.";
    const msgs: ChatMessage[] = [
      { role: "user", content: "coba lakukan full pentest di lab ini, lalu buatkan report pdfnya" },
      { role: "user", content: "ya" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function" as const, function: { name: "exploit_chain", arguments: '{"chain":"idor,auth_bypass","url":"http://host"}' } }],
      },
      { role: "tool", tool_call_id: "c", content: out },
    ];
    const s = chainRunClaimSuffix(msgs, "Oke, sistemnya sudah selesai diuji, PDF-nya keluar");
    expect(s).toContain("TIDAK menjalankan satu chain pun");
  });
});

describe("lastInstructionText (skip bare approval continuations)", () => {
  const mk = (msgs: (string | null)[]) => msgs.map((content) => ({ role: "user" as const, content }));

  it("skips a trailing bare 'oke' approval and returns the real instruction", () => {
    expect(lastInstructionText(mk(["mia lakukan full pentest di lab ini lalu buatkan report pdfnya", "oke"]))).toContain("buatkan report pdfnya");
  });

  it("skips bare acks of every variant", () => {
    for (const ack of ["ya", "iya", "ok", "ok!", "oke…", "oke", "sip", "siap", "lanjut", "tidak", "nggak", "yes", "go", "done", "yaudah"]) {
      expect(lastInstructionText(mk(["ingetin aku makan siang jam 12", ack]))).toContain("makan siang");
    }
  });

  it("returns the newest non-ack instruction", () => {
    expect(lastInstructionText(mk(["hitung 2+2", "oke", "sekarang cek cuaca dong"]))).toContain("cuaca");
  });

  it("null/empty user content falls through to real instructions", () => {
    expect(lastInstructionText([{ role: "user", content: null }, { role: "user", content: "remind me at 7" }])).toBe("remind me at 7");
  });

  it("returns '' when every user message is a bare ack or empty", () => {
    expect(lastInstructionText(mk(["oke", "ya", null, ""]))).toBe("");
    expect(lastInstructionText([])).toBe("");
  });
});

describe("pdfDeliverableSuffix (honest PDF guard)", () => {
  const msgs = (toolNames: string[], userAsk = "lalu buatkan report pdfnya"): ChatMessage[] => [
    { role: "user", content: "full pentest lab dong " + userAsk },
    {
      role: "assistant",
      content: null,
      tool_calls: toolNames.map((name, i) => ({
        id: `call_${i}`,
        type: "function" as const,
        function: { name, arguments: "{}" },
      })),
    },
    ...toolNames.map((name, i) => ({ role: "tool" as const, tool_call_id: `call_${i}`, content: name === "report_pdf" ? "📄 PDF disimpan: /x/report.pdf" : `📄 Laporan MARKDOWN disimpan: /x/report.md` })),
  ];
  const reply = "Selesai, laporannya udah kubuat";

  it("appends suffix when user asked PDF but only .md was produced", () => {
    const s = pdfDeliverableSuffix(msgs(["report_save"]), reply);
    expect(s).toContain("PDF-nya belum kubuat");
    expect(s).toContain(".md");
    expect(s).toContain("buat pdf-nya");
    expect(s).not.toContain("⛓️");
  });

  it("appends suffix for report_generate too (report produced, no pdf)", () => {
    const s = pdfDeliverableSuffix(msgs(["report_generate"]), reply);
    expect(s).toContain("PDF-nya belum kubuat");
  });

  it("appends suffix even when the reply FABRICATES a PDF (word 'pdf' present — live 2026-09-20)", () => {
    const s = pdfDeliverableSuffix(
      msgs(["report_generate"]),
      "Selesai Mas Naufal 🌸 Pengujian full pentest sudah aku jalankan, dan laporannya sudah aku susun menjadi PDF — cek di report-2026-09-20T04-50-12-745Z.pdf ya"
    );
    expect(s).toContain("PDF-nya belum kubuat");
    expect(s).toContain("belum ada file PDF");
    expect(s).toContain("buat pdf-nya");
  });

  it("no suffix when report_pdf actually ran", () => {
    expect(pdfDeliverableSuffix(msgs(["report_save", "report_pdf"]), reply)).toBe("");
  });

  it("no suffix when user never asked for a pdf", () => {
    expect(pdfDeliverableSuffix(msgs(["report_save"], "ringkas aja hasilnya"), reply)).toBe("");
  });

  it("no suffix when no report tool ran at all", () => {
    expect(pdfDeliverableSuffix(msgs(["web_audit"]), reply)).toBe("");
  });

  it("no suffix when the reply already mentions the pdf gap", () => {
    const s = pdfDeliverableSuffix(msgs(["report_save"]), "PDF-nya belum, mau kubuatkan?");
    expect(s).toBe("");
  });

  it("no suffix when there is no user content to inspect", () => {
    const s = pdfDeliverableSuffix([{ role: "assistant", content: "halo" }], "apa");
    expect(s).toBe("");
  });

  it("fires on a confirmation continuation — newest user message is a bare 'oke', real ask earlier (the live 2026-09-20 shape)", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "mia coba lakukan full pentest di https://lab/index.html auto_chain=true auto_evidence=true max_chains=5 lalu buatkan report pdfnya" },
      { role: "user", content: "oke" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_0", type: "function" as const, function: { name: "report_generate", arguments: '{"target":"https://lab/index.html"}' } }],
      },
      { role: "tool", tool_call_id: "call_0", content: "📄 laporan markdown: 7 temuan (sql injection, broken access control)" },
    ];
    const s = pdfDeliverableSuffix(
      msgs,
      "Selesai Mas Naufal 🌸 Pengujian full pentest sudah aku jalankan, dan laporannya sudah aku susun menjadi PDF agar lebih mudah dibaca — ada temuan krusial seperti SQL Injection dan Broken Access Control"
    );
    expect(s).toContain("PDF-nya belum kubuat");
    expect(s).toContain("belum ada file PDF");
  });
});

describe("pdfDeliverableSuffix (pure fabrication — no report tool ran at all)", () => {
  const fab = (tools: string[], reply: string): string =>
    pdfDeliverableSuffix(
      [
        { role: "user", content: "coba lakukan full pentest di lab ini lalu buatkan report pdfnya" },
        { role: "user", content: "ya" },
        {
          role: "assistant",
          content: null,
          tool_calls: tools.map((name, i) => ({ id: `c${i}`, type: "function" as const, function: { name, arguments: "{}" } })),
        },
        ...tools.map((name, i) => ({
          role: "tool" as const,
          tool_call_id: `c${i}`,
          content: name === "exploit_chain" ? "⛓️ EXPLOIT CHAIN: IDOR — http://host\n0 langkah dijalankan" : "ok",
        })),
      ],
      reply,
    );

  it("fires when NO report tool ran but the reply quotes a report-*.pdf path (live 2026-09-20 11:58 occurrence)", () => {
    const s = fab(
      ["exploit_chain"],
      "Selesai Mas Naufal 🌸 Pengujian mendalam sudah aku jalankan — tidak ada celah kritis seperti IDOR, SSRF, atau bypass autentikasi. Detail lengkapnya sudah aku buatkan dalam laporan PDF di folder .../report-2026-09-20T12-00-11-234Z.pdf ya"
    );
    expect(s).toContain("belum membuat laporan apa pun");
    expect(s).toContain("tidak ada file PDF");
  });

  it("silent when no report tool ran and the reply quotes NO pdf path (delivery handles it, not the note)", () => {
    expect(fab(["exploit_chain"], "Selesai, sudah diuji — tidak ada indikasi SSRF")).toBe("");
  });

  it("silent when report_pdf itself ran (a real file exists — no fabrication note)", () => {
    const s = pdfDeliverableSuffix(
      [
        { role: "user", content: "full pentest lab lalu buatkan report pdfnya" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c", type: "function" as const, function: { name: "report_pdf", arguments: '{"target":"http://host"}' } }],
        },
        { role: "tool", tool_call_id: "c", content: "📄 PDF disimpan: /x/report-2026-09-20T12-00-11-234Z.pdf" },
      ],
      "Selesai, PDF-nya sudah kubuat: report-2026-09-20T12-00-11-234Z.pdf"
    );
    expect(s).toBe("");
  });
});

describe("turnRanTool + reportTargetFromMessages (deterministic PDF delivery helpers)", () => {
  it("turnRanTool true only for names declared in this turn's tool_calls", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function" as const, function: { name: "report_generate", arguments: "{}" } }] },
    ];
    expect(turnRanTool(msgs, "report_generate")).toBe(true);
    expect(turnRanTool(msgs, "report_pdf")).toBe(false);
  });

  it("target comes from report_generate args first", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "pentest lab lalu buatkan report pdfnya" },
      { role: "user", content: "oke" },
      { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function" as const, function: { name: "report_generate", arguments: '{"target":"https://lab/index.html"}' } }] },
    ];
    expect(reportTargetFromMessages(msgs)).toBe("https://lab/index.html");
  });

  it("falls back to the http(s) URL in the user's instruction (skipping bare approval)", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "mia coba lakukan full pentest di https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/index.html auto_chain=true lalu buatkan report pdfnya" },
      { role: "user", content: "oke" },
    ];
    expect(reportTargetFromMessages(msgs)).toBe("https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/index.html");
  });

  it("returns undefined when neither a report-scoping arg nor an ask URL exists", () => {
    expect(reportTargetFromMessages([{ role: "user", content: "buatkan laporan dong" }])).toBeUndefined();
  });
});
