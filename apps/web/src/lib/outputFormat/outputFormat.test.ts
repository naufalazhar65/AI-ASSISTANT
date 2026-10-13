/**
 * Output formatter tests.
 *
 * House rule from this repo: a green test proves nothing on its own, so every
 * behaviour the brief demands is asserted BOTH ways — fire on the dishonest or
 * missing case, silent on the honest/correct one. A guard that never fires is
 * indistinguishable from a guard that is wired up.
 *
 * The 12 scenarios the brief mandates are marked [S1]..[S12].
 */

import { describe, expect, it } from "vitest";
import { chunkText, DISCORD_MAX } from "../../channels/replyChunk";
import { applyOutputFormat, classifyTask, hasEvidentiaryClaims, outputFormatGuidance, renderForChannel, validateOutput } from "./index";
import { FORMATTERS } from "./registry";
import { TASK_TYPES, type TaskType } from "./taskTypes";

const RESEARCH_ANSWER = [
  "## Title",
  "Biaya smart contract pada jaringan testnet, semester ini",
  "",
  "## Executive Summary",
  "Biaya naik dua kali lipat sejak Maret, dan rollback terjadi di dua jaringan.",
  "",
  "## Key Findings",
  "1. Biaya gas naik — fakta terverifikasi dari data on-chain; sumber: https://example.com/gas-data",
  "2. Dua incident rollback — https://example.com/incident-1",
  "",
  "## Conclusion",
  "Takeaway: biaya membengkak. Belum diketahui apakah ini permanen.",
].join("\n");

describe("registry integrity", () => {
  it("has exactly one formatter per task type, no extras", () => {
    expect(Object.keys(FORMATTERS).sort()).toEqual([...TASK_TYPES].sort());
  });

  it("every formatter declares a template letter, a label and a guidance block", () => {
    for (const type of TASK_TYPES) {
      const spec = FORMATTERS[type];
      expect(spec.taskType).toBe(type);
      expect(spec.template).toMatch(/^[A-J]$/);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.guidance.length).toBeGreaterThan(10);
    }
  });

  it("security audit and test report demand their integrity sections", () => {
    expect(FORMATTERS.security_audit.requiredSections.map((s) => s.id)).toContain("findings");
    expect(FORMATTERS.test_report.requiredSections.map((s) => s.id)).toContain("failed_tests");
    expect(FORMATTERS.test_report.evidence).toBe("required");
    expect(FORMATTERS.security_audit.completionStatus).not.toBe("none");
  });

  it("conversational types never demand report sections", () => {
    for (const t of ["general_chat", "question_answer", "discord_message"] as TaskType[]) {
      expect(FORMATTERS[t].requiredSections).toHaveLength(0);
      expect(FORMATTERS[t].conciseness).not.toBe("report");
    }
  });
});

describe("classification [S1] [S2] [S3]", () => {
  it("[S1] a simple factual question stays a short answer, not a report", () => {
    const c = classifyTask({ askText: "jam berapa sekarang?" });
    expect(c.taskType).toBe("question_answer");
    expect(FORMATTERS[c.taskType].conciseness).not.toBe("report");
  });

  it("[S2] a research ask is NEVER general chat", () => {
    for (const ask of ["riset tentang biaya cloud 2026", "tolong teliti soal X", "cari tahu tentang pasaridon secara mendalam"]) {
      const c = classifyTask({ askText: ask });
      expect(c.taskType).not.toBe("general_chat");
      expect(["research_report", "question_answer"]).toContain(c.taskType);
    }
    // Trend vocabulary is a DIFFERENT template on purpose (A covers both, but the
    // label must distinguish them so the viral-claim rule can apply).
    expect(classifyTask({ askText: "riset tentang tren AI 2026" }).taskType).toBe("news_and_trends");
    expect(classifyTask({ askText: "riset tentang biaya cloud 2026" }).taskType).toBe("research_report");
  });

  it("[S2b] a coding ask is NEVER a research report", () => {
    const c = classifyTask({ askText: "buatkan fungsi untuk parse CSV di file utils", executedTools: ["file_read"] });
    expect(c.taskType).toBe("coding_result");
    expect(c.taskType).not.toBe("research_report");
  });

  it("[S2c] Michelle's own turn classifies as coding even with a vague ask", () => {
    expect(classifyTask({ askText: "tolong tangani ini", agent: "michelle", executedTools: ["file_edit"] }).taskType).toBe(
      "coding_result",
    );
    expect(classifyTask({ askText: "tolong tangani ini", agent: "agnes", executedTools: ["web_search"] }).taskType).toBe(
      "research_report",
    );
  });

  it("[S3] viral-trends asks classify as news_and_trends, and small ones as a question", () => {
    expect(classifyTask({ askText: "cari topik viral di Twitter minggu ini", agent: "agnes" }).taskType).toBe("news_and_trends");
    expect(classifyTask({ askText: "ada kabar apa?" }).taskType).toBe("question_answer");
  });

  it("security vocabulary wins over research vocabulary", () => {
    const c = classifyTask({ askText: "audit keamanan lab: cari temuan dengan severity" });
    expect(c.taskType).toBe("security_audit");
  });

  it("explicit table request for a comparison is honoured", () => {
    expect(classifyTask({ askText: "bandingkan postgres vs mysql dalam tabel" }).taskType).toBe("comparison");
    expect(classifyTask({ askText: "bandingkan postgres vs mysql dalam tabel" }).explicitFormat).toBe("table");
  });

  // CHANGED 2026-10-13: a tool error no longer erases the shape of a report-shaped
  // ask. The "failure must not read as a success" rule is carried by the
  // success-claimed-on-failure check, which fires on the TEXT; the label override
  // was redundant AND lossy (it suppressed every section on a turn that still had
  // real findings). error_report is still reachable -- see the next test.
  it("a failing tool keeps a report-shaped ask on its own template", () => {
    const c = classifyTask({ askText: "buatkan laporan mingle", agent: "agnes", toolError: true });
    expect(c.taskType).toBe("research_report");
    expect(c.taskType).not.toBe("error_report");
  });

  it("a failing tool with no report signal becomes error_report", () => {
    const c = classifyTask({ askText: "halo", toolError: true });
    expect(c.taskType).toBe("error_report");
    expect(c.basis).toBe("outcome");
  });

  it("test and review shapes are separated from generic coding", () => {
    expect(classifyTask({ askText: "jalankan test dan kasih tahu hasilnya", agent: "michelle" }).taskType).toBe("test_report");
    // ...and a failing test run does not relabel the turn away from the template.
    expect(classifyTask({ askText: "jalankan test dan kasih tahu hasilnya", agent: "michelle", toolError: true }).taskType).toBe(
      "test_report",
    );
    expect(classifyTask({ askText: "perbaiki error di kode ini", agent: "michelle" }).taskType).toBe("debugging_report");
  });
});

describe("validation [S4] [S5] [S6] [S9]", () => {
  it("[S5] a failed tool result cannot be formatted as an all-clear report", () => {
    const issues = validateOutput({
      text: "## Summary\nSemua berhasil, tidak ada masalah sama sekali.",
      taskType: "coding_result",
      executedTools: ["npm_test"],
      toolError: true,
    });
    expect(issues.map((i) => i.code)).toContain("success-claimed-on-failure");
  });

  it("[S5b] the same text with no failure is silent", () => {
    const issues = validateOutput({
      text: "## Summary\nSemua berhasil, tidak ada masalah sama sekali.",
      taskType: "coding_result",
      executedTools: ["npm_test"],
      toolError: false,
    });
    expect(issues.map((i) => i.code)).not.toContain("success-claimed-on-failure");
  });

  it("[S9] an honest failure answer is reported as a failure, never as a success", () => {
    const out = applyOutputFormat({
      text: "## Problem\n`npm test` gagal: 3 suite gagal.\n\n## Root Cause\nCONFIRMED — fixture tidak dikomentari.",
      askText: "perbaiki test yang gagal",
      channel: "chat",
      executedTools: ["npm_test"],
      toolError: true,
    });
    // Label: a failing test run keeps the test template (changed 2026-10-13 --
    // the error override suppressed the report structure of a turn that still had
    // real content). The property that matters is that it is NOT a success report.
    expect(out.outcome.taskType).toBe("test_report");
    expect(out.outcome.issues.map((i) => i.code)).not.toContain("success-claimed-on-failure");
    expect(out.text).toContain("gagal");
    expect(out.text).not.toContain("semua test lulus");
    expect(out.outcome.fallback).toBe(false);
  });

  it("[S4] a 'tests passed' claim with no test runner in the turn is flagged", () => {
    const issues = validateOutput({
      text: "## Summary\nSelesai.\n\n## Files Changed\n- `a.ts`\n\n## Validation\nSemua test lulus.",
      taskType: "coding_result",
      executedTools: ["file_edit"],
    });
    expect(issues.map((i) => i.code)).toContain("unsupported-test-claim");
  });

  it("[S4b] the same claim WITH a real test run is silent", () => {
    const issues = validateOutput({
      text: "## Summary\nSelesai.\n\n## Files Changed\n- `a.ts`\n\n## Validation\nSemua test lulus.",
      taskType: "coding_result",
      executedTools: ["npm_test"],
    });
    expect(issues.map((i) => i.code)).not.toContain("unsupported-test-claim");
  });

  it("[S3b] a 'sent' claim without a delivery tool is flagged; with one it is silent", () => {
    const text = "## Task\nRiset.\n\n## Actions Taken\nRiset.\n\n## Result\nSelesai.\n\n## Delivery Status\nSudah dikirim ke channel Discord.";
    expect(validateOutput({ text, taskType: "task_execution_report" }).map((i) => i.code)).toContain(
      "unsupported-completion-claim",
    );
    // both passive forms must be caught
    expect(
      validateOutput({ text: text.replace("Sudah dikirim", "Sudah terkirim"), taskType: "task_execution_report" }).map((i) => i.code),
    ).toContain("unsupported-completion-claim");
    expect(
      validateOutput({ text, taskType: "task_execution_report", executedTools: ["send_channel"] }).map((i) => i.code),
    ).not.toContain("unsupported-completion-claim");
  });

  it("[S6] a report with no source at all is flagged as missing evidence", () => {
    const text = ["## Title", "x", "", "## Executive Summary", "y", "", "## Key Findings", "1. hal", "", "## Conclusion", "z"].join("\n");
    expect(validateOutput({ text, taskType: "research_report" }).map((i) => i.code)).toContain("missing-evidence");
  });

  it("[S6b] the same report WITH a source link is silent", () => {
    expect(validateOutput({ text: RESEARCH_ANSWER, taskType: "research_report" }).map((i) => i.code)).not.toContain(
      "missing-evidence",
    );
  });

  it("missing required sections are reported, never invented", () => {
    const issues = validateOutput({ text: "Ini jawaban seadanya tanpa struktur apa pun.", taskType: "security_audit" });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("missing-section");
    expect(issues.filter((i) => i.code === "missing-section").map((i) => i.sectionId)).toContain("findings");
  });

  it("sections found out of declared order are reported", () => {
    const text = ["## Limitations", "l", "", "## Scope", "s", "", "## Findings", "1. f"].join("\n");
    expect(validateOutput({ text, taskType: "security_audit" }).map((i) => i.code)).toContain("section-out-of-order");
  });

  it("a heading inside a fenced code block does not count as a section", () => {
    const text = ["## Scope", "s", "", "```md", "## Findings", "```", "", "## Findings", "1. real"].join("\n");
    const issues = validateOutput({ text, taskType: "security_audit" });
    expect(issues.filter((i) => i.code === "missing-section").map((i) => i.sectionId)).toEqual([]);
    // ...and the mirrored check: without the real heading, it IS reported.
    const onlyFence = ["## Scope", "s", "", "```md", "## Findings", "```"].join("\n");
    expect(
      validateOutput({ text: onlyFence, taskType: "security_audit" })
        .filter((i) => i.code === "missing-section")
        .map((i) => i.sectionId),
    ).toContain("findings");
  });

  it("an empty answer is reported as empty", () => {
    expect(validateOutput({ text: "   ", taskType: "research_report" }).map((i) => i.code)).toEqual(["empty-answer"]);
  });
});

describe("rendering [S8] [S11] [S12]", () => {
  it("[S11] a short conversational answer is never decorated", () => {
    const out = applyOutputFormat({
      text: "Halo Mas! Jam 13:36 sekarang 🌸",
      askText: "halo",
      channel: "discord",
    });
    expect(out.text).toBe("Halo Mas! Jam 13:36 sekarang 🌸");
    expect(out.outcome.rendered).toBe(false);
  });

  it("chat passthrough leaves the answer byte-identical", () => {
    const out = renderForChannel("## A\n\n- one\n- two", "chat");
    expect(out.text).toBe("## A\n\n- one\n- two");
    expect(out.transformed).toBe(false);
  });

  it("discord turns headings into bold and never drops a URL", () => {
    const out = renderForChannel("## Findings\n\n1. see https://example.com/a\n2. see https://example.com/b", "discord");
    expect(out.text).not.toContain("## ");
    expect(out.text).toContain("**Findings**");
    expect(out.text).toContain("https://example.com/a");
    expect(out.text).toContain("https://example.com/b");
  });

  it("slack converts markdown links to <url|label> and keeps the URL", () => {
    const out = renderForChannel("## A\n\n[label](https://example.com/x)", "slack");
    expect(out.text).toContain("<https://example.com/x|label>");
    expect(out.text).toContain("https://example.com/x");
  });

  it("tables are flattened without losing any cell", () => {
    const table = ["## Table", "", "| Tool | Rate |", "| --- | --- |", "| a | 5 |", "| b | 6 |"].join("\n");
    for (const channel of ["discord", "slack"] as const) {
      const out = renderForChannel(table, channel);
      expect(out.text).not.toContain("| --- |");
      expect(out.text).toContain("a");
      expect(out.text).toContain("Rate: 5");
      expect(out.text).toContain("b");
      expect(out.text).toContain("Rate: 6");
    }
  });

  it("content inside fenced code blocks is never rewritten", () => {
    const text = ["## A", "", "```md", "## Not a heading", "| a | b |", "```"].join("\n");
    const out = renderForChannel(text, "discord");
    expect(out.text).toContain("## Not a heading");
    expect(out.text).toContain("| a | b |");
  });

  it("[S8] a long report splits into ordered chunks that keep every section and citation", () => {
    const long = [
      "## Title",
      "Laporan panjang",
      "",
      "## Executive Summary",
      "Ringkasan yang cukup panjang untuk mengisi beberapa pesan.".repeat(30),
      "",
      "## Key Findings",
      ...Array.from({ length: 12 }, (_, i) => `${i + 1}. Temuan dengan sumber https://example.com/src-${i + 1} beserta dampak dan konsekuensinya`),
      "",
      "## Conclusion",
      "Kesimpulan beserta keterbatasannya.".repeat(30),
    ].join("\n");
    const rendered = renderForChannel(long, "discord").text;
    const chunks = chunkText(rendered, DISCORD_MAX);
    expect(chunks.length).toBeGreaterThan(1);
    for (const needle of ["Title", "Executive Summary", "Key Findings", "Conclusion"]) {
      expect(chunks.join("\n")).toContain(needle);
    }
    for (let i = 1; i <= 12; i += 1) {
      expect(chunks.join("\n")).toContain(`https://example.com/src-${i}`);
    }
  });

  it("[S12] an explicit JSON request with a JSON body is passed through untouched", () => {
    const body = '{"a":1,"b":[2,3]}';
    const out = applyOutputFormat({ text: body, askText: "kasih hasilnya dalam JSON", channel: "chat" });
    expect(out.outcome.explicitFormat ?? out.outcome.taskType).toBeTruthy();
    expect(out.text).toBe(body);
  });

  it("[S12b] a JSON request whose answer is NOT json is still left alone (never reformatted)", () => {
    const prose = "Ini penjelasanmu dalam bentuk paragraf, bukan JSON.";
    const out = applyOutputFormat({ text: prose, askText: "kasih hasil JSON", channel: "chat" });
    expect(out.text).toBe(prose);
  });

  it("[S10] formatting is idempotent: applying it twice changes nothing", () => {
    const first = applyOutputFormat({ text: RESEARCH_ANSWER, askText: "riset tentang X", channel: "discord" });
    const second = applyOutputFormat({ text: first.text, askText: "riset tentang X", channel: "discord" });
    expect(second.text).toBe(first.text);
  });

  // -- live 2026-10-13 (second round): Agnes WROTE the sections, just not with
  // our literal words -- "Ringkasan", "KESIMPULAN", "📊 ..." with an emoji. That
  // is personality, and the brief forbids the formatter from overriding it, but an
  // exact-string validator would have reported a correct report as broken. So
  // section detection is alias-based, and the renderer bolds a label it
  // recognises without renaming it.
  const EMOJI_LABELLED_REPORT = [
    "📰 Tren Biaya Cloud 2026",
    "Ringkasan: pasarcloud tahun ini didorong AI.",
    "🔥 Kenapa ramai: lonjakan chip AI.",
    "Waktu: Oktober 2026",
    "🔗 Sumber: TechCrunch",
    "📊 KESIMPULAN",
    "Efisiensi AI menjadi penentu utama.",
  ].join("\n");

  it("alias-based detection: Indonesian + emoji labels count as the section", () => {
    const issues = validateOutput({
      text: "📊 KESIMPULAN\nEfisiensi AI menjadi penentu utama. Sumber: https://contoh.id/a",
      taskType: "research_report",
    });
    expect(issues.filter((i) => i.code === "missing-section").map((i) => i.sectionId)).not.toContain("conclusion");
  });

  it("alias detection still fails when the section is genuinely absent", () => {
    const issues = validateOutput({
      text: "Ini paragraf tanpa satu pun label seksi. Sumber: https://contoh.id/a",
      taskType: "research_report",
    });
    expect(issues.filter((i) => i.code === "missing-section").map((i) => i.sectionId)).toContain("conclusion");
  });

  it("discord bolds a recognised emoji label and keeps the emoji (no renaming)", () => {
    const out = renderForChannel(EMOJI_LABELLED_REPORT, "discord");
    expect(out.text).toContain("**📊 KESIMPULAN**");
    expect(out.text).toContain("📰 Tren Biaya Cloud 2026");
    expect(out.text).toContain("🔥 Kenapa ramai");
  });

  it("slack bolds the same label in single-asterisk mrkdwn", () => {
    const out = renderForChannel(EMOJI_LABELLED_REPORT, "slack");
    expect(out.text).toContain("*📊 KESIMPULAN*");
  });

  it("never double-bolds an already decorated label", () => {
    for (const channel of ["discord", "slack"] as const) {
      const once = renderForChannel("**KESIMPULAN**\nisi", channel).text;
      const twice = renderForChannel(once, channel).text;
      expect(twice).toBe(once);
      expect(twice).not.toContain("****");
    }
  });

  it("every registered section declares at least its own title as an alias", () => {
    for (const [type, spec] of Object.entries(FORMATTERS)) {
      for (const section of [...spec.requiredSections, ...spec.optionalSections]) {
        expect(section.aliases.length, `${type}/${section.id} has no alias`).toBeGreaterThan(0);
        expect(section.aliases).toContain(section.title.toLowerCase());
      }
    }
  });

  // -- live 2026-10-13 (third round, from a REAL turn): two defects my own earlier
  // work produced, both caught by running the pipeline instead of reading it.
  it("an emoji label that ALREADY carries bold is not bolded twice", () => {
    // First-char check missed this: the emoji sits before the asterisks, and the
    // live Agnes answer rendered as `**📊 **KESIMPULAN****`.
    const out = renderForChannel("📊 **KESIMPULAN**", "discord");
    expect(out.text).toBe("📊 **KESIMPULAN**");
    expect(out.text).not.toContain("****");
  });

  it("the integrity note must NOT accuse an honest answer that makes no claim", () => {
    // Michelle live: "daftar temuan kita masih kosong karena belum ada tes yang
    // dijalankan" -- no assertion, so a "no sources" note was a FALSE ACCUSATION.
    const honest = "Mas Naufal, daftar temuan kita masih kosong karena belum ada tes yang dijalankan.";
    const out = applyOutputFormat({
      text: honest,
      askText: "tulis laporan audit keamanan singkat dengan temuan dan severity",
      agent: "michelle",
      channel: "discord",
      executedTools: ["finding_list"],
    });
    expect(out.text).toBe(honest);
    expect(out.outcome.issues.map((i) => i.code)).toContain("missing-evidence");
  });

  it("the integrity note MUST fire on an answer that does assert without sources", () => {
    // Michelle round 2 verbatim shape: claims a proven SQLi with zero links.
    const claiming = [
      "Hasil uji endpoint /api/cari-berita dengan payload SQL Injection lewat poc_verify menunjukkan respons sukses dengan baseline yang benar-benar berbeda, membuktikan adanya celah SQLi yang membocorkan kredensial.",
      "⚙️ poc_verify → /api/cari-berita?q=zzz: (dieksekusi)",
    ].join("\n");
    const out = applyOutputFormat({
      text: claiming,
      askText: "audit keamanan lab ini, laporkan temuannya dengan severity",
      agent: "michelle",
      channel: "discord",
      executedTools: ["poc_verify"],
    });
    expect(out.text).toContain("(Catatan:");
    expect(out.text).toContain("tidak memuat tautan sumber");
  });

  it("hasEvidentiaryClaims is the gate: assertion marker + length, both ways", () => {
    expect(hasEvidentiaryClaims(claiming_text_long())).toBe(true);
    expect(hasEvidentiaryClaims("Daftar temuan kita masih kosong karena belum ada tes yang dijalankan.")).toBe(false);
    expect(hasEvidentiaryClaims("terbukti")).toBe(false);
  });

  function claiming_text_long(): string {
    return "Hasil uji menunjukkan respons berbeda dari baseline sehingga membuktikan adanya celah SQLi pada endpoint lab ini secara langsung.".repeat(2);
  }

  // -- live 2026-10-13 (fourth round, from a real audit turn) -----------------
  it("a tool error must NOT erase the shape of a report-shaped ask", () => {
    // Michelle's audit hit two `finding_add` errors; error_report's "answer"
    // conciseness suppressed every section on a turn that still had findings.
    const c = classifyTask({
      askText: "audit keamanan lab ini, laporkan temuannya dengan severity",
      agent: "michelle",
      toolError: true,
    });
    expect(c.taskType).toBe("security_audit");
    expect(c.taskType).not.toBe("error_report");
  });

  it("a tool error on a NON-report ask still becomes error_report", () => {
    expect(classifyTask({ askText: "halo", toolError: true }).taskType).toBe("error_report");
  });

  it("'merespons dengan aman terhadap X' is a success claim that must be flagged", () => {
    const issues = validateOutput({
      text: "Endpoint /api/cari-berita merespons dengan aman terhadap karakter khusus dan tidak membocorkan data sensitif pada pengujian ini.",
      taskType: "security_audit",
      executedTools: ["poc_verify"],
      toolError: true,
    });
    expect(issues.map((i) => i.code)).toContain("success-claimed-on-failure");
  });

  it("a bare 'aman' in ordinary prose must NOT trip the safety-claim guard", () => {
    const issues = validateOutput({
      text: "Situsnya aman dimuat dengan cepat di jaringan rumah, sudah aku cek beberapa kali dari perangkat ini.",
      taskType: "question_answer",
      executedTools: ["http_request"],
      toolError: false,
    });
    expect(issues.map((i) => i.code)).not.toContain("success-claimed-on-failure");
  });

  // -- live 2026-10-13 regression: the guidance block LOST to the channel hint --
  // `discordFormatInstruction` already says "do NOT invent heading levels" and
  // "keep every reply short". A first guidance block asked for section labels
  // without saying HOW to write them; the model resolved the conflict towards the
  // channel rule and produced ZERO headings (audit: "research_report/A discord:
  // 0 heading(s) as bold"). The classifier was right; the instruction lost.
  it("guidance must state the override explicitly, or the channel hint wins", () => {
    for (const channel of ["chat", "discord", "slack"] as const) {
      const g = outputFormatGuidance(channel) ?? "";
      expect(g).toMatch(/OVERRIDES the channel rule/);
      // The carve-out is now a TRIGGER rule, not a length rule: a short ask that
      // needs searching must still use the shape. Asserted so the permission-to-
      // be-brief wording cannot come back.
      expect(g).toMatch(/Skip this block ONLY when you can answer from what you already know/i);
      expect(g).toMatch(/even if the ask is one short sentence/i);
    }
  });

  it("guidance is channel-aware: '##' is banned on Discord/Slack and required on chat", () => {
    expect(outputFormatGuidance("discord")).toMatch(/do NOT use `##` on Discord/i);
    expect(outputFormatGuidance("discord")).toMatch(/\*\*Executive Summary\*\*/);
    expect(outputFormatGuidance("slack")).toMatch(/SINGLE-asterisk bold/);
    expect(outputFormatGuidance("chat")).toMatch(/starting with `## `/);
  });

  it("guidance gives every report family one concrete shape to imitate", () => {
    for (const channel of ["chat", "discord", "slack"] as const) {
      const g = outputFormatGuidance(channel) ?? "";
      expect(g).toContain("imitate the layout");
      // Every emphasised family must be listed, not just some of them.
      for (const family of [
        "research_report, news_and_trends",
        "security_audit, code_review",
        "coding_result, test_report",
        "debugging_report, error_report",
        "task_execution_report, status_update",
        "comparison",
      ]) {
        expect(g).toContain(family);
      }
    }
  });

  it("guidance stays compact enough for the request-size budget", () => {
    const g = outputFormatGuidance("discord") ?? "";
    expect(g.length).toBeGreaterThan(200);
    // Cap raised from 4000: a one-line shape was measurably too weak to move a
    // small model (live 2026-10-13), and full section skeletons fixed it. The
    // binding budget is the SLIM prompt, asserted separately in verify.ts.
    expect(g.length).toBeLessThan(4600);
  });

  it("voice/plain never gets the report shape", () => {
    const out = applyOutputFormat({ text: RESEARCH_ANSWER, askText: "riset tentang X", channel: "plain" });
    expect(out.outcome.rendered).toBe(false);
    expect(outputFormatGuidance(undefined)).toBeUndefined();
    expect(outputFormatGuidance("plain")).toBeUndefined();
    expect(outputFormatGuidance("discord")).toContain("OUTPUT SHAPE");
  });
});

describe("end-to-end shape [S2] [S3]", () => {
  it("[S2] a research answer reaches Discord as a readable report, links intact", () => {
    const out = applyOutputFormat({
      text: RESEARCH_ANSWER,
      askText: "tolong riset tentang biaya cloud 2026",
      channel: "discord",
      agent: "agnes",
      executedTools: ["web_search"],
    });
    expect(out.outcome.taskType).toBe("research_report");
    expect(out.outcome.template).toBe("A");
    expect(out.text).toContain("https://example.com/gas-data");
    expect(out.text).not.toContain("## ");
    const chunks = chunkText(out.text, DISCORD_MAX);
    expect(chunks.join("\n")).toContain("Key Findings");
  });

  it("[S3] a viral-trends ask with a real Discord delivery is not flagged as a false delivery claim", () => {
    const text = [
      "## Title",
      "Tren viral minggu ini",
      "",
      "## Executive Summary",
      "Dua topik benar-benar viral, sisanya coverage biasa.",
      "",
      "## Key Findings",
      "1. Tren terverifikasi — volume penyebutan naik|source: https://example.com/trend",
      "",
      "## Conclusion",
      "Belum jelas apakah mereda.",
    ].join("\n");
    const out = applyOutputFormat({
      text,
      askText: "cari topik viral minggu ini lalu kirim ke Discord",
      channel: "discord",
      agent: "agnes",
      executedTools: ["web_search", "send_channel"],
    });
    expect(out.outcome.taskType).toBe("news_and_trends");
    expect(out.outcome.issues.map((i) => i.code)).not.toContain("unsupported-completion-claim");
  });
});