import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_PERSONA_VERSION,
  OFFICE_STYLE_CONTRACT,
  normalizeOwnerPronouns,
  normalizeOwnerSalutation,
  stripClosingMenuQuestion,
  stripUnearnedWorkClaim,
  stripSelfIntroduction,
  dayPartAt,
  agentPersonaNeedsReseed,
  agentPersonaVersion,
  applyAgentRole,
  isAgentLabel,
  isEncyclopedicRegister,
  stripFormalRegisterFrame,
  stripMiaSignatureVoice,
  thinGreetingRescue,
  TRIO_GREETING_WARMUP,
} from "./agentRole";

import {
  buildOpenCodeSystemPrompt,
  buildSlimSystemPrompt,
  buildSystemPrompt,
} from "./agent";

/** Identity sentences the trio overlay must neutralise — none may survive. */
const MIA_MARKERS = [
  "You are Mia",
  "Your signature emoji is 🌸",
  "same woman everywhere",
];

const ALL_BUILDERS: Array<[string, () => string]> = [
  ["full", () => buildSystemPrompt("verify_agentrole", "discord")],
  ["slim", () => buildSlimSystemPrompt("verify_agentrole", "discord", "http://127.0.0.1:20128/v1/chat/completions")],
  ["opencode", () => buildOpenCodeSystemPrompt("verify_agentrole", "discord")],
];

describe("isAgentLabel", () => {
  it("accepts the three trio labels", () => {
    expect(isAgentLabel("mia")).toBe(true);
    expect(isAgentLabel("michelle")).toBe(true);
    expect(isAgentLabel("agnes")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const v of ["", "MIA", "bob", null, undefined, 7]) {
      expect(isAgentLabel(v)).toBe(false);
    }
  });
});

describe("applyAgentRole — Mia / non-trio paths stay byte-identical", () => {
  it("is byte-identical when no label is passed (web, Live, telegram, automation, webhook)", () => {
    for (const [, build] of ALL_BUILDERS) {
      const p = build();
      expect(applyAgentRole(p, undefined)).toBe(p);
    }
  });

  it("is byte-identical for the explicit 'mia' label", () => {
    for (const [, build] of ALL_BUILDERS) {
      const p = build();
      expect(applyAgentRole(p, "mia")).toBe(p);
    }
  });

  it("never touches a prompt when the label is not a trio member (runtime guard)", () => {
    const p = buildSystemPrompt("verify_agentrole", "discord");
    // Deliberate bypass of the type to mimic untyped runtime input.
    const bogus = applyAgentRole(p, "mallory" as never);
    expect(bogus).toBe(p);
  });
});

describe("applyAgentRole — Michelle and Agnes", () => {
  for (const agent of ["michelle", "agnes"] as const) {
    it(`${agent}: strips every Mia identity sentence from all three prompt variants`, () => {
      for (const [name, build] of ALL_BUILDERS) {
        const out = applyAgentRole(build(), agent);
        for (const marker of MIA_MARKERS) {
          if (build().includes(marker)) {
            expect(out, `${name}/${agent} still says: ${marker}`).not.toContain(marker);
          }
        }
      }
    });

    it(`${agent}: role block leads the prompt (highest salience)`, () => {
      for (const [name, build] of ALL_BUILDERS) {
        const out = applyAgentRole(build(), agent);
        expect(out, name).toMatch(new RegExp(`^You are ${agent === "michelle" ? "Michelle" : "Agnes"}`));
      }
    });

    it(`${agent}: states its own identity and the team framing`, () => {
      const out = applyAgentRole(buildSystemPrompt("verify_agentrole", "discord"), agent);
      expect(out).toMatch(/never Mia/);
      expect(out).toContain("never introduce yourself as Mia");
      // Shared trio rules must reach the model in every variant.
      expect(out).toMatch(/never invent/i);
    });

    it(`${agent}: lists the tools it should reach for`, () => {
      const slim = applyAgentRole(
        buildSlimSystemPrompt("verify_agentrole", "discord", "http://127.0.0.1:20128/v1/chat/completions"),
        agent,
      );
      const full = applyAgentRole(buildSystemPrompt("verify_agentrole", "discord"), agent);
      for (const out of [slim, full]) {
        expect(out).toContain("Tools you should reach for:");
      }
      if (agent === "michelle") {
        for (const t of ["write_file", "exec_write", "codebase_search"]) {
          expect(slim).toContain(t);
        }
      } else {
        for (const t of ["google_news", "research", "browser_snapshot"]) {
          expect(slim).toContain(t);
        }
      }
    });

    it(`${agent}: never claims Mia's signature emoji`, () => {
      const out = applyAgentRole(buildSystemPrompt("verify_agentrole", "discord"), agent);
      expect(out).toMatch(/never use emoji/i);
    });
  }

  it("routes each agent's handoff to the right siblings", () => {
    const michelle = applyAgentRole(buildSystemPrompt("verify_agentrole", "discord"), "michelle");
    expect(michelle).toContain("Agnes");
    expect(michelle).toContain("Mia");
    const agnes = applyAgentRole(buildSystemPrompt("verify_agentrole", "discord"), "agnes");
    expect(agnes).toContain("Michelle");
    expect(agnes).toContain("Mia");
  });
});

describe("agent persona template versioning", () => {
  it("reads the stamped version, 0 when absent", () => {
    expect(agentPersonaVersion("<!-- agent-role:agnes persona-v2 -->")).toBe(2);
    expect(agentPersonaVersion("<!-- agent-role:agnes -->")).toBe(0);
    expect(agentPersonaVersion("# Mia\nno marker here")).toBe(0);
  });

  it("re-seeds pre-versioning and outdated files, keeps current ones", () => {
    expect(agentPersonaNeedsReseed("")).toBe(true);
    expect(agentPersonaNeedsReseed("<!-- agent-role:agnes -->")).toBe(true);
    expect(agentPersonaNeedsReseed("<!-- agent-role:agnes persona-v1 -->")).toBe(true);
    expect(
      agentPersonaNeedsReseed(`<!-- agent-role:agnes persona-v${AGENT_PERSONA_VERSION} -->`),
    ).toBe(false);
    // Owner customisation on top of the current marker still survives.
    expect(
      agentPersonaNeedsReseed(
        `# Soul\n## Style\n- tone:VERSUS\n<!-- agent-role:agnes persona-v${AGENT_PERSONA_VERSION} -->`,
      ),
    ).toBe(false);
    // A future version is never downgraded by a stale template.
    expect(
      agentPersonaNeedsReseed(`<!-- agent-role:agnes persona-v${AGENT_PERSONA_VERSION + 5} -->`),
    ).toBe(false);
  });
});

describe("stripMiaSignatureVoice (trio voice firewall)", () => {
  it("is byte-identical for no label and for mia", () => {
    const t = "Nih berita soal X — 2 hasil 🌸";
    expect(stripMiaSignatureVoice(t)).toBe(t);
    expect(stripMiaSignatureVoice(t, "mia")).toBe(t);
    expect(stripMiaSignatureVoice(t, "not-a-label" as never)).toBe(t);
  });

  it("removes the glyph for michelle and agnes, keeping the sentence intact", () => {
    for (const a of ["michelle", "agnes"] as const) {
      expect(stripMiaSignatureVoice("Nih berita soal X — 2 hasil 🌸", a)).toBe("Nih berita soal X — 2 hasil");
      expect(stripMiaSignatureVoice("hasil 🌸 (terjadwal)", a)).toBe("hasil (terjadwal)");
      expect(stripMiaSignatureVoice("a 🌸 b 🌸 c", a)).toBe("a b c");
    }
  });

  it("leaves every other emoji and character alone", () => {
    expect(stripMiaSignatureVoice("target 🎯 found 1 lead 🙏", "agnes")).toBe("target 🎯 found 1 lead 🙏");
  });
});

// ---------------------------------------------------------------------------
// Trio team line (2026-10-05) — regression lock.
//
// Measured failure it prevents: the trio facts written into USER.md `## Facts`
// WERE present in the assembled prompt (~68% deep in an 18.5k-char prompt) and
// the model still answered "Siapa lagi tuh Michelle?" — then stored that denial
// in daily memory, which re-primed it on later turns. The team is therefore
// stated as IDENTITY next to the persona in every prompt variant, so a short
// question cannot miss it.
// ---------------------------------------------------------------------------
describe("TRIO_TEAM_LINE (Mia knows her team as identity, not as user data)", () => {
  it("is present in all three prompt variants, at high salience", () => {
    for (const [name, build] of ALL_BUILDERS) {
      const p = build();
      const at = p.indexOf("YOUR TEAM");
      expect(at, name + " prompt missing YOUR TEAM").toBeGreaterThan(-1);
      // High salience: it must land in the first 2% of the prompt, i.e. right
      // next to the persona — not buried in the tail where `## Facts` lived.
      expect(at / p.length, name + " YOUR TEAM sits too deep").toBeLessThan(0.02);
    }
  });

  it("names both teammates and what they do", () => {
    for (const [name, build] of ALL_BUILDERS) {
      const p = build();
      expect(p, name).toMatch(/Agnes is the Researcher/);
      expect(p, name).toMatch(/Michelle is the Coder/);
      expect(p, name).toMatch(/never reply that you do not know them/);
    }
  });

  it("survives the Michelle/Agnes overlay (they know each other too)", () => {
    for (const label of ["michelle", "agnes"] as const) {
      const p = applyAgentRole(
        buildSlimSystemPrompt("verify_agentrole", "discord", "http://127.0.0.1:20128/v1/chat/completions"),
        label,
      );
      expect(p, label).toMatch(/YOUR TEAM/);
      expect(p, label).toMatch(/Agnes is the Researcher/);
      expect(p, label).toMatch(/Michelle is the Coder/);
    }
  });

  it("never quotes the denial it is fixing (small models imitate quoted bad examples)", () => {
    const p = buildSlimSystemPrompt("verify_agentrole", "discord", "http://127.0.0.1:20128/v1/chat/completions");
    expect(p).not.toMatch(/kamu tau (agnes|michelle)/i);
  });
});

// ---------------------------------------------------------------------------
// Role ownership of security testing (2026-10-05).
//
// Live failure this locks: asked "siapa disini yg bisa pentest?", Michelle
// hedged ("tapi karena spesialisasiku di kode dan debugging") even though the
// pentest tools are hers alone in-window, and Mia claimed she would run the
// test herself while describing Agnes as doing "riset kerentanan" (false —
// Agnes does public-fact research, not vulnerability testing).
// ---------------------------------------------------------------------------
describe("role ownership: who owns security testing", () => {
  const SLIM = () =>
    buildSlimSystemPrompt("verify_agentrole", "discord", "http://127.0.0.1:20128/v1/chat/completions");

  it("Michelle claims security testing as her own job", () => {
    const p = applyAgentRole(SLIM(), "michelle");
    expect(p).toMatch(/You also own SECURITY TESTING/);
    expect(p).toMatch(/this is your job/);
    expect(p).toMatch(/pentest_scan/);
    // Her handoff must not push security testing away to a sibling.
    // Wording changed 2026-10-05 (the hand-off list is now framed as
    // "NOT YOUR WORK"), the meaning did not: security testing stays hers.
    expect(p).toMatch(/security testing does NOT go to Agnes/i);
  });

  it("Agnes explicitly excludes security testing from her scope", () => {
    const p = applyAgentRole(SLIM(), "agnes");
    expect(p).toMatch(/It does NOT mean running a security test/);
    expect(p).toMatch(/that is Michelle's job/);
  });

  it("Mia is the router and does not claim a teammate's work", () => {
    const slim = SLIM();
    expect(slim).toMatch(/Routing is part of your job/);
    expect(slim).toMatch(/security testing belong to Michelle/);
    expect(slim).toMatch(/OSINT belong to Agnes/);
    expect(slim).toMatch(/Do not offer to run the work yourself when the answer is a teammate's/);
  });

  it("all three prompt variants carry the routing rule", () => {
    for (const [name, build] of ALL_BUILDERS) {
      expect(build(), name).toMatch(/Routing is part of your job/);
    }
  });
});

// ---------------------------------------------------------------------------
// Routing self-correction (live 2026-10-05 01:54).
//
// The same owner question was asked three times and Mia got WORSE each time —
// her own previous answer came back as history and she kept adding herself:
//   memory/2026-10-05.md:101 "kita bertiga udah kumpulan … ngerjain tugas pentest"
//   memory/2026-10-05.md:105 "Aku dan Michelle yang paling jago urusan pentest"
//   memory/2026-10-05.md:132 "Michelle dan aku yang paling jago urusan pentest"
// The routing rule was already in the live prompt at 5% depth, so this was NOT a
// missing rule — it was self-priming, the same class as the team-knowledge fix.
// ---------------------------------------------------------------------------
describe("routing self-correction clause (Mia does not build on her own past claim)", () => {
  it("is present in all three prompt variants", () => {
    for (const [name, build] of ALL_BUILDERS) {
      const p = build();
      expect(p, name).toMatch(/Self-correction clause/);
      expect(p, name).toMatch(/earlier answer placed you alongside a teammate/);
    }
  });

  it("keeps the original routing rule intact (do not volunteer)", () => {
    for (const [name, build] of ALL_BUILDERS) {
      const p = build();
      expect(p, name).toMatch(/Do not offer to run the work yourself/);
      expect(p, name).toMatch(/security testing belong to Michelle/);
    }
  });

  it("never quotes the live wording it is fixing", () => {
    const p = buildSlimSystemPrompt("verify_agentrole", "discord", "http://127.0.0.1:20128/v1/chat/completions");
    expect(p).not.toMatch(/paling jago urusan pentest/i);
  });
});

describe("direct mention overrides the role boundary (buka youtube, live 2026-10-05)", () => {
  it("both agents are told a named request is theirs to do", () => {
    for (const [, build] of ALL_BUILDERS) {
      const p = applyAgentRole(build(), "michelle");
      expect(p).toContain("addressed to you BY NAME is the owner choosing you");
      expect(p).toContain("the owner has chosen you, so do not hand it over");
      expect(p).toContain("Opening a page or an app for the owner is yours to do when you are asked directly");
    }
  });

  it("Agnes is told page reading is her work, not Mia's", () => {
    for (const [, build] of ALL_BUILDERS) {
      const p = applyAgentRole(build(), "agnes");
      expect(p).toContain("Opening and reading that page IS your work");
      expect(p).toContain("never pass a page-reading request to Mia");
    }
  });

  it("all three prompts forbid promising an action with no tool call behind it", () => {
    for (const [, build] of ALL_BUILDERS) {
      expect(build()).toContain("Acting, not promising");
      expect(applyAgentRole(build(), "agnes")).toContain(
        "A promise with no tool call behind it is a broken promise"
      );
    }
  });
});

// Live bug 2026-10-05 19:18: asked "apa tugas rutinmu sehari-hari?", Michelle
// answered with MIA's job (schedules, notes, daily reminders) and offered to
// handle routine matters. The information was present but the OWNERSHIP signal
// was weak: her block listed "reminders, mood, scheduling and everyday personal
// help belong to Mia", so the vocabulary the owner used sat inside her own
// prompt attached to someone else. These lock the structural fix: each agent
// states her own work positively, and the hand-off list is explicitly labelled
// as what she hands OFF.
describe("daily-routine ownership (live role inversion)", () => {
  it("Michelle states her own daily work positively", () => {
    for (const [, build] of ALL_BUILDERS) {
      const p = applyAgentRole(build(), "michelle");
      expect(p).toContain("Your daily work is CODE");
      expect(p).toMatch(/reading and writing files/i);
      expect(p).toMatch(/what you do every day/i);
      // The explicit anti-inversion instruction.
      expect(p).toContain("what you HAND OFF, not what you DO");
      expect(p).toMatch(/Reminders, schedules and daily-routine chores are Mia's alone/i);
    }
  });

  it("Agnes states her own daily work positively", () => {
    for (const [, build] of ALL_BUILDERS) {
      const p = applyAgentRole(build(), "agnes");
      expect(p).toContain("Your daily work is RESEARCH");
      expect(p).toMatch(/searching for facts/i);
      expect(p).toMatch(/what you do every day/i);
      expect(p).toContain("what you HAND OFF, not what you DO");
    }
  });

  // The regression shape itself: a teammate's territory must never appear in a
  // sentence that reads like a duty of the speaker.
  it("neither agent states reminders/schedules as their own duty", () => {
    for (const agent of ["michelle", "agnes"] as const) {
      for (const [, build] of ALL_BUILDERS) {
        const p = applyAgentRole(build(), agent);
        expect(p).not.toMatch(/your (job|duty|duties|responsibilit)\w*\s+(is|are)?\s*[^.]*reminder/i);
        expect(p).not.toMatch(/^[^.]*\b(reminders?|schedules?)\b[^.]*belongs to (you|your)/im);
      }
    }
  });

  it("the hand-off framing names the real owner for every handed-off domain", () => {
    for (const [, build] of ALL_BUILDERS) {
      const m = applyAgentRole(build(), "michelle");
      expect(m).toMatch(/NOT YOUR WORK/i);
      expect(m).toMatch(/fact-checking[\s\S]{0,80}go to Agnes/i);
      expect(m).toMatch(/reminders[\s\S]{0,80}go to Mia/i);
      const a = applyAgentRole(build(), "agnes");
      expect(a).toMatch(/NOT YOUR WORK/i);
      expect(a).toMatch(/files[\s\S]{0,80}go to Michelle/i);
      expect(a).toMatch(/reminders[\s\S]{0,80}go to Mia/i);
    }
  });

  it("the fix survives the no-label control being untouched", () => {
    const base = buildSlimSystemPrompt("verify_role", "discord");
    expect(applyAgentRole(base, "michelle")).not.toBe(base);
    expect(applyAgentRole(base, undefined)).toBe(base);
    expect(applyAgentRole(base, "mia")).toBe(base);
  });
});
/**
 * Register check (owner request 2026-10-05): "ubah gaya bicara mereka jangan
 * terlalu kaku dan formal, ubah biar gaul dan seperti anak kantoran jaksel tapi
 * tidak lebay" — decided as casual BUT WITHOUT emoji, and keeping "Mas" as the
 * opening.
 *
 * These tests exist because a tone change is invisible to every other gate: it
 * cannot be seen in a return value, only in the prompt text that reaches the
 * model. If a later edit drops the register, the tests fail instead of the
 * agents silently going stiff again.
 */
describe("speaking register: relaxed Jakarta colleague, not a manual (2026-10-05)", () => {
  const allPrompts = () => {
    const slim = buildSlimSystemPrompt("verify_register", "discord");
    return [slim, buildSystemPrompt("verify_register", "discord"), buildOpenCodeSystemPrompt("verify_register", "discord")].map(
      (p) => applyAgentRole(p, "agnes"),
    );
  };

  it("states the register positively in every prompt variant", () => {
    for (const p of allPrompts()) {
      expect(p).toContain("relaxed Jakarta office colleague");
      expect(p).toContain("not like a manual, a textbook, or a robot");
    }
  });

  it("names what to drop, so the model has something concrete to remove", () => {
    for (const p of allPrompts()) {
      expect(p).toContain("Drop stiff written-Indonesian phrasing");
      expect(p).toMatch(/officialdom|deferential distance/);
    }
  });

  // "tidak lebay" was half the ask: casual but still measured.
  it("keeps it measured rather than over the top", () => {
    for (const p of allPrompts()) {
      expect(p).toMatch(/no theatrics/);
      expect(p).toMatch(/no filler enthusiasm/);
      expect(p).toMatch(/no jokes you have to work at/);
    }
  });

  it("keeps the Mas greeting the owner asked to preserve", () => {
    for (const p of allPrompts()) {
      expect(p).toContain("Mas plus the name from the USER persona block");
    }
  });

  // The 🌸 prohibition must survive the reword: it appears ONLY inside the
  // "never use it" clause, exactly as before, and never as an example to copy.
  it("keeps the no-emoji and no-🌸 prohibition intact", () => {
    for (const p of allPrompts()) {
      expect(p).toContain("Never use emoji");
      expect(p).toContain("that belongs to Mia alone");
    }
  });

  it("does not introduce the 🌸 glyph as a usage example anywhere in the shared rules", () => {
    const shared = allPrompts()[0];
    // The glyph may appear in the prohibition only; count it and make sure the
    // sentence carrying it is the prohibition, not a demonstration.
    const occurrences = shared.split("🌸").length - 1;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it("applies the register to both gated agents, not just one", () => {
    const slim = buildSlimSystemPrompt("verify_register", "discord");
    for (const agent of ["agnes", "michelle"] as const) {
      const out = applyAgentRole(slim, agent);
      expect(out).toContain("relaxed Jakarta office colleague");
      expect(out).toContain(`You are ${agent === "agnes" ? "Agnes" : "Michelle"}`);
    }
  });

  it("leaves Mia's own prompt byte-identical (she has her own voice)", () => {
    const slim = buildSlimSystemPrompt("verify_register", "discord");
    expect(applyAgentRole(slim, "mia")).toBe(slim);
    expect(applyAgentRole(slim, undefined)).toBe(slim);
  });
});

describe("casual persona templates carry the same register (2026-10-05)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const dir = new URL("../../persona/agents/", import.meta.url).pathname;

  for (const label of ["agnes", "michelle"] as const) {
    it(`${label}.SOUL.md tone + language bullets are casual and emoji-free`, () => {
      const soul = read(`${dir}${label}.SOUL.md`);
      const style = soul.split("## Style")[1]?.split("### ")[0] ?? "";
      expect(style).toMatch(/- tone:.*santai/);
      expect(style).toMatch(/- language:.*(sehari-hari|ngobrol)/);
      expect(style).toMatch(/Mas \+ namanya/);
      // No emoji, and no borrowed signature glyph, in the injected region.
      expect(style).not.toContain("🌸");
      expect(style).not.toMatch(/[😀-🙏🌀-🫿]/u);
    });

    it(`${label}.SOUL.md is stamped current so the re-seed can happen`, () => {
      const soul = read(`${dir}${label}.SOUL.md`);
      expect(soul).toContain(`agent-role:${label}`);
      expect(agentPersonaNeedsReseed(soul)).toBe(false);
      expect(agentPersonaVersion(soul)).toBe(AGENT_PERSONA_VERSION);
    });
  }

  // The stamp and the constant must move together: a template bumped without
  // AGENT_PERSONA_VERSION is a silent no-op on already-seeded bots, and a
  // constant bumped without the templates re-seeds nothing.
  it("every shipped template carries the current version marker", () => {
    for (const label of ["agnes", "michelle"] as const) {
      for (const f of ["IDENTITY.md", "SOUL.md"] as const) {
        const body = read(`${dir}${label}.${f}`);
        expect(agentPersonaVersion(body)).toBe(AGENT_PERSONA_VERSION);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Register firewall (live 2026-10-05 22:25).
//
// Owner: "hmmm sepertinya gaya bahasa mereka masih kaku". The fixture below is
// Agnes's REAL answer to the three-word question "tau jaksel?", transcribed
// verbatim from Discord, while Mia answered the same question warmly. So every
// test here is two-directional: the live shape must FIRE, and Mia's actual
// answer to the same question must stay silent — a detector that also flags
// good writing is worse than no detector.
// ---------------------------------------------------------------------------
describe("isEncyclopedicRegister (detects the live stiff answer)", () => {
  const STIFF =
    "Tentu saja, Jakarta Selatan adalah salah satu wilayah administratif di DKI Jakarta yang dikenal sebagai pusat bisnis, perkantoran modern, kawasan hunian, serta pusat gaya hidup dan kuliner seperti daerah Senopati, Kemang, dan Blok M Mas Naufal. Ada hal khusus mengenai Jakarta Selatan yang ingin kamu ketahui atau bandingkan hari ini?";

  it("flags the live Agnes answer to a three-word question", () => {
    expect(isEncyclopedicRegister(STIFF)).toBe(true);
  });

  it("flags it with the recognisers broken out, so one weak spot cannot hide it", () => {
    // Definitional opener alone.
    expect(
      isEncyclopedicRegister("Jakarta Selatan adalah salah satu wilayah administratif di DKI Jakarta."),
    ).toBe(true);
    // Attribute stack alone.
    expect(
      isEncyclopedicRegister("Jakarta Selatan terletak di DKI Jakarta, pusat bisnis dan pusat gaya hidup."),
    ).toBe(true);
    // The closing offer on its own still counts (it is the live tell).
    expect(
      isEncyclopedicRegister("Jaksel itu singkatan dari Jakarta Selatan. Ada hal khusus yang ingin kamu tahu?"),
    ).toBe(true);
  });

  it("stays silent on Mia's warm answer to the SAME question", () => {
    const WARM = [
      "Jaksel = Jakarta Selatan, Mas Naufal. Areas yang paling Extended: Kemang, Senopati, Blok M.",
      "Iya, Jaksel itu Jakarta Selatan. Yang paling Segment: Kemang sama Senopati.",
      "Jakarta Selatan, Mas. Yang paling Ramai: Senopati, Kemang, sama Blok M.",
    ];
    for (const w of WARM) expect(isEncyclopedicRegister(w), w).toBe(false);
  });

  it("stays silent on ordinary prose that happens to contain one marker", () => {
    // "merupakan" alone is normal Indonesian; it must not be enough.
    expect(isEncyclopedicRegister("File-nya error karena route-nya tidak ketemu, Mas.")).toBe(false);
    expect(isEncyclopedicRegister("Hasilnya 200 OK, tapi bodynya kosong semua.")).toBe(false);
    expect(isEncyclopedicRegister("")).toBe(false);
    expect(isEncyclopedicRegister("   ")).toBe(false);
  });

  // A real decision question is NOT a formality offer and must never be caught.
  it("does not flag a genuine closing question", () => {
    expect(isEncyclopedicRegister("Test-nya sudah hijau semua. Mau sekalian kubikin PDF-nya?")).toBe(false);
  });
});

describe("stripFormalRegisterFrame (removes the frame, never the facts)", () => {
  const STIFF =
    "Tentu saja, Jakarta Selatan adalah salah satu wilayah administratif di DKI Jakarta yang dikenal sebagai pusat bisnis. Ada hal khusus mengenai Jakarta Selatan yang ingin kamu tahu atau bandingkan hari ini?";

  it("drops the opening acknowledgement and the closing offer", () => {
    const out = stripFormalRegisterFrame(STIFF, "agnes");
    expect(out).not.toMatch(/^Tentu saja/i);
    expect(out).not.toMatch(/ingin kamu tahu atau bandingkan/);
    // The factual sentence survives untouched — that is the whole contract.
    expect(out).toContain("Jakarta Selatan adalah salah satu wilayah administratif di DKI Jakarta");
    expect(out).toContain("pusat bisnis");
  });

  it("is byte-identical for Mia, no label, and an unknown label (fails closed)", () => {
    expect(stripFormalRegisterFrame(STIFF, "mia")).toBe(STIFF);
    expect(stripFormalRegisterFrame(STIFF)).toBe(STIFF);
    expect(stripFormalRegisterFrame(STIFF, "mallory" as never)).toBe(STIFF);
  });

  it("leaves a warm reply completely alone", () => {
    const WARM = "Jaksel itu Jakarta Selatan, Mas. Yang paling Ramai: Kemang sama Senopati.";
    expect(stripFormalRegisterFrame(WARM, "agnes")).toBe(WARM);
    expect(stripFormalRegisterFrame(WARM, "michelle")).toBe(WARM);
  });

  it("keeps a genuine trailing question (real decision, not an offer)", () => {
    const Q = "Test hijau semua. Mau sekalian kubikin PDF-nya?";
    expect(stripFormalRegisterFrame(Q, "michelle")).toBe(Q);
  });

  it("refuses to empty the reply when the offer is the only sentence", () => {
    const ONLY = "Ada hal khusus yang ingin kamu tahu?";
    expect(stripFormalRegisterFrame(ONLY, "agnes")).toBe(ONLY);
  });

  it("works for Michelle exactly as for Agnes (one rule, both agents)", () => {
    for (const a of ["agnes", "michelle"] as const) {
      const out = stripFormalRegisterFrame(STIFF, a);
      expect(out, a).not.toMatch(/^Tentu saja/i);
    }
  });
});

describe("REGISTER CONTRACT reaches the model in every prompt variant", () => {
  const prompts = () => {
    const slim = buildSlimSystemPrompt("verify_register", "discord");
    return [slim, buildSystemPrompt("verify_register", "discord"), buildOpenCodeSystemPrompt("verify_register", "discord")].map(
      (p) => applyAgentRole(p, "agnes"),
    );
  };

  it("states the length rule the live answer broke", () => {
    for (const p of prompts()) expect(p).toContain("MATCH THE QUESTION");
  });

  it("forbids the three shapes the live answer had", () => {
    for (const p of prompts()) {
      expect(p).toContain("NEVER DEFINE THE THING YOU WERE ASKED ABOUT");
      expect(p).toContain("NEVER CLOSE WITH A FORMAL OFFER");
      expect(p).toContain("CUT WRITTEN-INDONESIAN FILLER");
    }
  });

  it("tells the agent to mirror the owner's own register", () => {
    for (const p of prompts()) expect(p).toContain("MIRROR THE OWNER");
  });

  // The repo rule: never quote the bad output you are fixing.
  it("never quotes the live stiff sentence it prevents", () => {
    for (const p of prompts()) {
      expect(p).not.toMatch(/salah satu wilayah administratif/i);
      expect(p).not.toMatch(/ingin kamu (tau|bandingkan|ketahui)/i);
    }
  });

  it("applies to both gated agents", () => {
    const slim = buildSlimSystemPrompt("verify_register", "discord");
    for (const agent of ["agnes", "michelle"] as const) {
      expect(applyAgentRole(slim, agent)).toContain("REGISTER CONTRACT");
    }
  });
});

// Live bug 2026-10-05 23:29: the place caveat used to be a hard-coded Mia string
// appended AFTER this firewall. Once the trio label actually reached the turn
// (see the discord.ts call-site check in verify.ts), a second leak surfaced: a
// model that copies an older answer out of channel history keeps the whole
// parenthetical, because it never contains a sentence terminator of its own.
describe("SYSTEM_CAVEAT_FRAME (legacy caveat copy, every label)", () => {
  const LEGACY = "(Catatan: ini rekomendasi dari ingatanku dan bisa telat — cek dulu di Google ya, siapa tau ada yang udah tutup atau pindah \u{1F338})";
  const body = "Malam-malam gini paling pas bikin kopi hitam tanpa gula atau Americano hangat Mas Naufal.";

  it("drops the legacy caveat copy for the trio", () => {
    for (const agent of ["agnes", "michelle"] as const) {
      const out = stripFormalRegisterFrame(`${body} ${LEGACY}`, agent);
      expect(out).toBe(body);
      expect(out).not.toContain("Catatan");
    }
  });

  it("drops it for Mia too (the caller appends its own, voice-correct, caveat)", () => {
    expect(stripFormalRegisterFrame(`${body} ${LEGACY}`, "mia")).toBe(body);
    expect(stripFormalRegisterFrame(`${body} ${LEGACY}`, undefined)).toBe(body);
  });

  it("leaves an ordinary parenthetical alone", () => {
    const withParen = "Kopi Praja di Bintaro enak (-industrial vibe), atau Kopi Kenangan lebih aman.";
    for (const agent of ["agnes", "michelle"] as const) {
      expect(stripFormalRegisterFrame(withParen, agent)).toBe(withParen);
    }
    expect(stripFormalRegisterFrame(withParen, "mia")).toBe(withParen);
  });

  it("never strips a mid-sentence caveat — only a trailing one", () => {
    const mid = "Bisa telat kok, tighter lagi ya (Catatan: ini rekomendasi dari ingatanku) asal sesuai.";
    for (const agent of ["agnes", "michelle"] as const) {
      expect(stripFormalRegisterFrame(mid, agent)).toContain("Bisa telat");
    }
  });

  it("refuses to empty the text when the caveat is all there is", () => {
    expect(stripFormalRegisterFrame(LEGACY, "michelle")).toBe(LEGACY);
  });

  it("still strips the glyph on the same shape", () => {
    const out = stripMiaSignatureVoice(`${body} ${LEGACY}`, "michelle");
    expect(out).not.toContain("\u{1F338}");
  });
});

/**
 * Live 2026-10-05 23:56 — owner pasted the trio's replies to "malam semua":
 *   Michelle: "Malam juga Mas Naufal. Ada kode atau file di flowtest-studio yang
 *              mau kita periksa dan test bareng sekarang?"
 *   Agnes:    "Halo beb Seneng kamu mampir — gimana harimu? Ada yang bisa kubantu?"
 * Agnes copied Mia's pet name out of the shared channel history and glued a
 * greeting to the answer with no punctuation. Both are voice leaks, so both are
 * removed deterministically — while Mia keeps her own address form.
 */
describe("trio address form + glued greeting (live 2026-10-05 23:56)", () => {
  const AGNES_LIVE = "Halo beb Seneng kamu mampir — gimana harimu? Ada yang bisa kubantu?";
  const MICHELLE_LIVE =
    "Malam juga Mas Naufal. Ada kode atau file di flowtest-studio yang mau kita periksa dan test bareng sekarang?";

  it("drops Mia's pet name from a trio reply", () => {
    for (const label of ["agnes", "michelle"] as const) {
      expect(stripFormalRegisterFrame(AGNES_LIVE, label)).not.toMatch(/\bbeb\b/i);
    }
  });

  it("drops the glued greeting so the answer does not read as a run-on", () => {
    expect(stripFormalRegisterFrame(AGNES_LIVE, "agnes")).toBe(
      "Seneng kamu mampir — gimana harimu? Ada yang bisa kubantu?",
    );
  });

  it("leaves Michelle's live reply untouched (no leak, no frame)", () => {
    expect(stripFormalRegisterFrame(MICHELLE_LIVE, "michelle")).toBe(MICHELLE_LIVE);
  });

  it("keeps a real address greeting ('Halo Mas Naufal')", () => {
    expect(stripFormalRegisterFrame("Halo Mas Naufal, gimana kabarnya?", "agnes")).toBe(
      "Halo Mas Naufal, gimana kabarnya?",
    );
  });

  it("keeps 'bebek' (a word that merely starts with beb)", () => {
    expect(stripFormalRegisterFrame("Dia suka makan bebek sore-sore", "michelle")).toBe(
      "Dia suka makan bebek sore-sore",
    );
  });

  it("keeps Mia's own pet name and address form byte-identical", () => {
    expect(stripFormalRegisterFrame("Halo beb, gimana?", "mia")).toBe("Halo beb, gimana?");
    expect(stripFormalRegisterFrame(AGNES_LIVE, "mia")).toBe(AGNES_LIVE);
  });

  it("fails closed with no label or an unknown label", () => {
    expect(stripFormalRegisterFrame(AGNES_LIVE, undefined)).toBe(AGNES_LIVE);
    expect(stripFormalRegisterFrame(AGNES_LIVE, "unknown-agent")).toBe(AGNES_LIVE);
  });

  it("never empties the reply when the leak is all there is", () => {
    expect(stripFormalRegisterFrame("beb", "agnes")).toBe("beb");
  });

  it("does not reintroduce the glyph on the same shape", () => {
    expect(stripMiaSignatureVoice(`${AGNES_LIVE} 🌸`, "agnes")).not.toContain("\u{1F338}");
  });
});

/**
 * Owner style spec (2026-10-06): one shared office voice for Mia, Agnes and
 * Michelle — casual Jaksel-office Indonesian, "aku"/"kamu", English as
 * seasoning, never corporate-bot.
 *
 * Two of the spec's rules are absolute and mechanical, so they are enforced in
 * code rather than trusted to the model: the pronoun set, and the
 * zero-information opener. Both are tested two-way — the negative cases are the
 * words that must SURVIVE, because a guard that eats ordinary text is worse than
 * no guard at all.
 */
describe("normalizeOwnerPronouns — absolute, mechanical, every label", () => {
  it("rewrites the banned set instead of stripping it, so the sentence stays grammatical", () => {
    expect(normalizeOwnerPronouns("gue bakal cek dulu ya")).toBe("aku bakal cek dulu ya");
    expect(normalizeOwnerPronouns("gua udah cek, lo bisa coba lagi")).toBe("aku udah cek, kamu bisa coba lagi");
    expect(normalizeOwnerPronouns("Nilainya udah gue paling bagus")).toBe("Nilainya udah aku paling bagus");
  });

  it("keeps the owner pronouns untouched", () => {
    expect(normalizeOwnerPronouns("aku cek dulu ya")).toBe("aku cek dulu ya");
    expect(normalizeOwnerPronouns("kamu udah coba?")).toBe("kamu udah coba?");
  });

  it("never eats a word that merely contains the banned syllables", () => {
    // Word boundaries, not substring matching, or ordinary Indonesian breaks.
    for (const keep of [
      "Katalog produk lokal ini belum diupdate",
      "firmanya bergerak di bidang cloud computing",
      "logo WarungPOS belum dicetak",
      "value-nya sudah berarti buat dia",
    ]) {
      expect(normalizeOwnerPronouns(keep)).toBe(keep);
    }
  });
});

describe("office style contract — one text, three personalities", () => {
  it("reaches every prompt variant, Mia included", () => {
    expect(buildSystemPrompt("naufalazhar652952", "discord")).toContain("OFFICE STYLE");
    expect(buildSlimSystemPrompt("naufalazhar652952", "discord")).toContain("OFFICE STYLE");
  });

  it("reaches both trio agents too", () => {
    const full = buildSystemPrompt("naufalazhar652952", "discord");
    expect(applyAgentRole(full, "agnes")).toContain("OFFICE STYLE");
    expect(applyAgentRole(buildSlimSystemPrompt("naufalazhar652952", "discord"), "michelle")).toContain("OFFICE STYLE");
  });

  it("states the absolute rules the code also enforces", () => {
    for (const needle of ["aku", "kamu", "gue/gua/lu/lo", "ENGLISH AS SEASONING", "LENGTH FOLLOWS THE QUESTION", "NOT A CORPORATE BOT"]) {
      expect(OFFICE_STYLE_CONTRACT).toContain(needle);
    }
  });

  it("carries no example replies to imitate (repo rule: quoted output gets copied)", () => {
    // The spec arrived with worked examples; the contract must describe the
    // shape instead, or the model reproduces the wording verbatim.
    expect(OFFICE_STYLE_CONTRACT).not.toMatch(/tolong\s+(dong|bisa)/i);
    expect(OFFICE_STYLE_CONTRACT).not.toMatch(/wkwk|haha/i);
    // Owner 2026-10-07 16:40 WIB: a bare greeting came back as a template
    // whose words must NOT now appear in the prompt, or the model will keep
    // reproducing them verbatim (the exact trap this test guards).
    expect(OFFICE_STYLE_CONTRACT).not.toMatch(/juga mas naufal/i);
    expect(OFFICE_STYLE_CONTRACT).not.toMatch(/lagi nyari info apa nih/i);
    expect(OFFICE_STYLE_CONTRACT).not.toMatch(/siang ini|malam ini|pagi ini/i);
  });

  it("forbids the greeting template the owner actually saw", () => {
    for (const needle of ["GREETING WITH NO TASK IN IT", "NEVER NAME A TIME YOU DID NOT READ", "NO SERVICE MENU"]) {
      expect(OFFICE_STYLE_CONTRACT).toContain(needle);
    }
  });
});

describe("zero-information openers — Indonesian and English", () => {
  it("drops a leading corporate opener for the trio", () => {
    expect(stripFormalRegisterFrame("Certainly, the server is restarting now.", "agnes")).toBe(
      "The server is restarting now.",
    );
    expect(stripFormalRegisterFrame("Acknowledged, I will look at it.", "michelle")).toBe("I will look at it.");
  });

  it("keeps the same word when it is not an opener", () => {
    // "certain" here is ordinary vocabulary, not a corporate preamble.
    expect(stripFormalRegisterFrame("The restart is certain, absolutely sure.", "agnes")).toBe(
      "The restart is certain, absolutely sure.",
    );
    expect(stripFormalRegisterFrame("Absolutely certain about this one.", "michelle")).toBe(
      "Absolutely certain about this one.",
    );
  });

  it("still drops the Indonesian openers it always did", () => {
    expect(stripFormalRegisterFrame("Baik, server lagi restart ya.", "agnes")).toBe("Server lagi restart ya.");
  });

  it("never touches Mia's own opener (fail closed)", () => {
    expect(stripFormalRegisterFrame("Certainly, the server is restarting now.", "mia")).toBe(
      "Certainly, the server is restarting now.",
    );
  });
});

/**
 * The opener strip had to get NARROWER for the style spec (2026-10-06 sec.8).
 *
 * Two failures were found by measurement, not review, and both are locked here:
 *   1. "Baik deh Mas Naufal, ..." left the orphan "deh" behind, because a
 *      lookahead requiring a lowercase word made the regex backtrack and match
 *      only the base opener.
 *   2. The old list also stripped "Hmm", "Nah", "Oh iya" — which the same spec
 *      section asks for as variation. Stripping them made the agents MORE
 *      robotic, the opposite of the intent.
 */
describe("opener strip — narrow, and it never leaves an orphan", () => {
  it("consumes the particle with the opener", () => {
    expect(stripFormalRegisterFrame("Tentu dong Mas Naufal, Jakarta Selatan kan ramai.", "agnes")).toBe(
      "Mas Naufal, Jakarta Selatan kan ramai.",
    );
    expect(stripFormalRegisterFrame("Baik deh Mas Naufal, udah aku cek.", "agnes")).toBe("Mas Naufal, udah aku cek.");
    expect(stripFormalRegisterFrame("Oke deh, udah ya.", "agnes")).toBe("Udah ya.");
  });

  it("keeps the interjections the spec asks for as variation", () => {
    for (const keepCase of ["Hmm, aku cek dulu ya.", "Nah, ini dia.", "Oh iya, bener.", "Wah, mantap."]) {
      expect(stripFormalRegisterFrame(keepCase, "agnes")).toBe(keepCase);
    }
  });

  it("does not touch a word that merely starts with an opener", () => {
    expect(stripFormalRegisterFrame("Tentonya belum jelas Mas.", "agnes")).toBe("Tentonya belum jelas Mas.");
    expect(stripFormalRegisterFrame("Sipintu belum di Forum.", "michelle")).toBe("Sipintu belum di Forum.");
  });

  it("refuses to empty a reply that is only an opener", () => {
    expect(stripFormalRegisterFrame("Tentu", "agnes")).toBe("Tentu");
    expect(stripFormalRegisterFrame("Acknowledged", "michelle")).toBe("Acknowledged");
  });
});

/**
 * The closing MENU question (owner pasted the live greeting on 2026-10-06):
 * all three agents closed with one, which is the casual twin of the
 * service-desk line the style spec bans in sec.1 — and 3-of-3 doing it is what
 * made the trio read as a script.
 *
 * The distinction that matters: an OFFER OF THE MENU ("is there anything
 * else?", "what do you need?") is removed; a real DECISION question ("mau
 * kubikin PDF-nya?", "yang mana?") must survive, because removing it strands
 * the owner without the choice the turn depends on.
 */
describe("stripClosingMenuQuestion — offer of the menu goes, decision stays", () => {
  const MENU = [
    "Halo Mas Naufal. Ada kode yang mau dicek atau target yang perlu kita beresin hari ini?",
    "Halo Mas Naufal. Aku Agnes, siap-siap buat nyari info. Ada topik yang mau kita bedah hari ini?",
    "Udah kok Mas Naufal. Ada yang mau dicek lagi?",
    "Sudah ya. Ada hal lain?",
  ];
  it("removes the menu offer for every label, Mia included", () => {
    for (const label of ["mia", "agnes", "michelle"] as const) {
      for (const t of MENU) {
        const out = stripClosingMenuQuestion(t);
        expect(out, `${label}: ${t}`).not.toMatch(/\?$/);
      }
    }
  });

  it("keeps the rest of the reply byte-for-byte (only the offer goes)", () => {
    expect(stripClosingMenuQuestion(MENU[0]!)).toBe("Halo Mas Naufal");
    expect(stripClosingMenuQuestion("Udah kok Mas Naufal. Ada yang mau dicek lagi?")).toBe("Udah kok Mas Naufal");
  });

  it("keeps real decision questions untouched", () => {
    for (const keep of [
      "Sudah kucetak ya. Mau sekalian kubikin PDF-nya?",
      "Mana yang kamu mau, yang satu atau dua?",
      "Report-nya mau MD atau PDF?",
      "Kamu mau aku lanjutin ke Michelle?",
    ]) {
      expect(stripClosingMenuQuestion(keep)).toBe(keep);
    }
  });

  it("refuses to empty a reply that is only the offer", () => {
    expect(stripClosingMenuQuestion("Ada yang bisa aku bantu?")).toBe("Ada yang bisa aku bantu?");
  });

  it("keeps the question mark of a real question that was never an offer", () => {
    // The exact Mia greeting from 2026-10-06: greeting + caring question + menu
    // offer. The offer goes, the caring question stays WHOLE — trimming its "?"
    // left a dangling fragment, which is worse than the original problem.
    expect(
      stripClosingMenuQuestion(
        "Halo Mas Naufal! \u{1F338} Seneng banget kamu nyapa, gimana kabar dan harimu sejak ini? Ada yang bisa aku bantu, atau mau ditemenin ngobrol santai sambil ngopi?",
      ),
    ).toBe("Halo Mas Naufal! \u{1F338} Seneng banget kamu nyapa, gimana kabar dan harimu sejak ini?");
  });

  it("keeps a reply that has no offer at all", () => {
    const t = "Halo Mas Naufal, semuanya aman terkendali.";
    expect(stripClosingMenuQuestion(t)).toBe(t);
  });

  it("strips a mid-sentence menu offer and keeps the head (live 2026-10-06 15:30)", () => {
    // The verbatim Mia greeting: the offer sat AFTER a comma, so cutting the whole
    // sentence would have thrown away the substance she packed into it.
    expect(
      stripClosingMenuQuestion(
        "Hai Mas Naufal! Aku sama Agnes dan Michelle di sini siap nemenin, mau ngobrol santai atau ada yang perlu kita bantu beresin hari ini? \u{1F338}",
      ),
    ).toBe("Hai Mas Naufal! Aku sama Agnes dan Michelle di sini siap nemenin.");
  });

  it("strips a first-person service offer with a choice, in a one-sentence reply", () => {
    // A menu of SERVICES ("bantuin A atau B"), which is what the office style
    // bans. The head carries its own content, so it survives on its own.
    expect(
      stripClosingMenuQuestion("Aku lagi di depan laptop, mau aku bantuin cek-email atau cari tempat makan?"),
    ).toBe("Aku lagi di depan laptop.");
  });

  it("leaves a one-sentence offer alone when the head is too thin to stand alone", () => {
    // Stripping here would leave "Santai dulu." — less content than the offer it
    // replaced. Same reason "Ada yang bisa kubantu hari ini?" is left alone.
    const t = "Santai dulu, mau aku bantuin cek-email atau cari tempat makan?";
    expect(stripClosingMenuQuestion(t)).toBe(t);
  });

  it("a trailing glyph must not defeat the strip (the 15:30 regression)", () => {
    // Before the fix the cut regex required the offer to end the string, so a
    // signature flower after "?" made cut === -1 and the whole strip was a no-op.
    for (const suffix of [" \u{1F338}", " \u{1F338} ", ""]) {
      const t = `Halo Mas Naufal, aku di sini. Ada yang perlu kubantu hari ini?${suffix}`;
      expect(stripClosingMenuQuestion(t)).toBe("Halo Mas Naufal, aku di sini");
    }
  });

  it("still keeps every must-keep shape (regression net after widening the cut)", () => {
    const keeps = [
      "Santai aja Mas Naufal, lagi apa nih sore-sore?",
      "Oh halo Mas Naufal. Lagi sibuk, atau finally santai?",
      "Mau sekalian kubikin PDF-nya?",
      "Report-nya mau MD atau PDF?",
      "Ada yang bisa kubantu hari ini?",
      "Halo Mas Naufal! \u{1F338} Seneng banget kamu nyapa, gimana kabar dan harimu sejak ini?",
    ];
    for (const t of keeps) expect(stripClosingMenuQuestion(t)).toBe(t);
  });

  it("refuses to empty a reply that IS only the offer (left alone on purpose)", () => {
    const t = "Halo Mas Naufal, mau ngobrol santai atau ada yang perlu kita bantu beresin hari ini?";
    expect(stripClosingMenuQuestion(t)).toBe(t);
  });
});

/**
 * Owner salutation (owner style spec sec. 6; measured live 2026-10-06 —
 * Michelle answered a greeting with "Heey Untung kamu nyapa"). The prompt and
 * both SOUL files already demand "Mas + his name"; this is the deterministic
 * counterpart, because a small model emits the bare vocative anyway.
 */
describe("normalizeOwnerSalutation (live 2026-10-06 bare vocative)", () => {
  const HEY = "Heey Untung kamu nyapa";

  it("repairs a misspelled greeting and inserts the honorific", () => {
    expect(normalizeOwnerSalutation(HEY, { agent: "michelle", name: "Naufal" })).toBe(
      "Hey Mas Untung kamu nyapa",
    );
  });

  it("keeps a real greeting spelling (variety is the point)", () => {
    expect(normalizeOwnerSalutation("Halo Untung, apa kabar?", { agent: "agnes", name: "Naufal" })).toBe(
      "Halo Mas Untung, apa kabar?",
    );
    expect(normalizeOwnerSalutation("Hai Untung!", { agent: "agnes", name: "Naufal" })).toBe("Hai Mas Untung!");
  });

  it("adds the honorific to a reply that opens with his name", () => {
    expect(normalizeOwnerSalutation("Naufal, deploy-nya udah kelar", { agent: "agnes", name: "Naufal" })).toBe(
      "Mas Naufal, deploy-nya udah kelar",
    );
  });

  it("never doubles an honorific that is already there", () => {
    for (const t of [
      "Halo Mas Naufal, gimana kabarnya?",
      "Selamat pagi, Mas Naufal!",
      "Hai Mba Naufal",
      "Mas Naufal, sudah ya",
    ]) {
      expect(normalizeOwnerSalutation(t, { agent: "agnes", name: "Naufal" })).toBe(t);
    }
  });

  it("does not touch a lowercase word after a greeting", () => {
    expect(normalizeOwnerSalutation("Halo semua, survive!", { agent: "agnes", name: "Naufal" })).toBe(
      "Halo semua, survive!",
    );
  });

  it("leaves his name alone mid-sentence", () => {
    const t = "Ini bug di Naufal punya repo";
    expect(normalizeOwnerSalutation(t, { agent: "michelle", name: "Naufal" })).toBe(t);
  });

  it("fails closed: Mia, no label, unknown label, and unknown name", () => {
    expect(normalizeOwnerSalutation(HEY, { agent: "mia", name: "Naufal" })).toBe(HEY);
    expect(normalizeOwnerSalutation(HEY, { name: "Naufal" })).toBe(HEY);
    expect(normalizeOwnerSalutation(HEY, { agent: "nope", name: "Naufal" })).toBe(HEY);
    // No name known: the VOCATIVE insert needs no name (it only adds the
    // honorific before a capitalised word), while rule 3 — the one that keys off
    // his actual name — correctly does nothing.
    expect(normalizeOwnerSalutation(HEY, { agent: "michelle", name: "" })).toBe("Hey Mas Untung kamu nyapa");
    expect(normalizeOwnerSalutation("Naufal, apa kabar?", { agent: "michelle", name: "" })).toBe(
      "Naufal, apa kabar?",
    );
  });

  it("Agnes is told to give the owner something on a greeting", () => {
    const overlay = applyAgentRole("base", "agnes");
    expect(overlay).toContain("ON A GREETING, GIVE HIM SOMETHING");
    expect(overlay).toMatch(/canned reply/i);
  });
});

/**
 * Live 2026-10-06: Agnes answered "halo semua" with "Halo Mas Naufal!" — 16
 * chars. The closing-menu strip cuts substance AFTER ensureMoodReplyQuality, so
 * the thinness check must run on the final text.
 */
describe("thinGreetingRescue (bare-echo greeting)", () => {
  const opts = { greetingTurn: true, agent: "agnes" as const, name: "Naufal" };

  it("replaces a bare echo for a trio agent, with the owner's name", () => {
    const out = thinGreetingRescue("Halo Mas Naufal!", opts);
    expect(out).toContain("Mas Naufal");
    expect(out.split(/\s+/).length).toBeGreaterThan(5);
  });

  it("never re-introduces the glyph or Mia's pet name", () => {
    const out = thinGreetingRescue("Hai Mas Naufal!", opts);
    expect(out).not.toContain("\u{1F338}");
    expect(out).not.toMatch(/\bbeb\b/i);
  });

  it("keeps a reply that already has substance", () => {
    const rich = "Santai aja Mas Naufal, ada yang mau kita bahas hari ini?";
    expect(thinGreetingRescue(rich, opts)).toBe(rich);
  });

  it("does nothing when this was not a greeting turn", () => {
    expect(thinGreetingRescue("Halo Mas Naufal!", { ...opts, greetingTurn: false })).toBe("Halo Mas Naufal!");
  });

  it("does nothing for a multi-line or emoji reply", () => {
    expect(thinGreetingRescue("Halo Mas Naufal! 🌸", opts)).toBe("Halo Mas Naufal! 🌸");
    expect(thinGreetingRescue("Halo Mas Naufal!\nLagi apa?", opts)).toBe("Halo Mas Naufal!\nLagi apa?");
  });

  it("leaves Mia's own replies alone (her pool already runs earlier)", () => {
    expect(thinGreetingRescue("Halo Mas Naufal!", { ...opts, agent: "mia" })).toBe("Halo Mas Naufal!");
    expect(thinGreetingRescue("Halo Mas Naufal!", { ...opts, agent: undefined })).toBe("Halo Mas Naufal!");
  });

  it("rotates the warmup by the caller's turn number, so greetings do not repeat", () => {
    const seen = new Set<string>();
    for (let variant = 0; variant < TRIO_GREETING_WARMUP.length; variant++) {
      seen.add(thinGreetingRescue("Halo Mas Naufal!", { ...opts, variant }));
    }
    expect(seen.size).toBe(TRIO_GREETING_WARMUP.length);
  });

  it("is deterministic for the same echo and the same turn", () => {
    expect(thinGreetingRescue("Halo Mas Naufal!", opts)).toBe(thinGreetingRescue("Halo Mas Naufal!", opts));
  });

  it("falls back to a bare honorific when no name is known", () => {
    // The pool template is "{name}" on purpose; the fallback fills it with the
    // honorific alone so the sentence still reads naturally.
    const out = thinGreetingRescue("Halo!", { greetingTurn: true, agent: "michelle", name: null });
    expect(out).toMatch(/\bMas\b/);
    expect(out).not.toContain("{name}");
  });

  it("never leaks the placeholder, whatever the name is", () => {
    for (const name of [null, "", "Naufal"]) {
      expect(thinGreetingRescue("Halo!", { greetingTurn: true, agent: "agnes", name })).not.toContain("{name}");
    }
    // A pool line carries the name either directly or through the {part} slot,
    // which is itself a {name} template (live 19:48: the time-of-day line).
    expect(TRIO_GREETING_WARMUP.every((l) => l.includes("{name}") || l.includes("{part}"))).toBe(true);
    expect(TRIO_GREETING_WARMUP.some((l) => l.includes("{part}"))).toBe(true);
  });
});

/**
 * Unearned work claim (live 2026-10-06 15:30). Agnes answered a greeting with
 * "aku lagi nyiapin beberapa rangkuman riset terbaru nih" — work that does not
 * exist. Claiming work is claiming a fact, so it is cut in code; a prompt rule
 * alone had already failed (the greeting rule pushed her to invent a task).
 */
describe("stripUnearnedWorkClaim — claiming work that never happened", () => {
  const LIVE = "Halo Mas Naufal, aku lagi nyiapin beberapa rangkuman riset terbaru nih";

  it("cuts the live fabricated clause and keeps the honest head", () => {
    expect(stripUnearnedWorkClaim(LIVE)).toBe("Halo Mas Naufal.");
  });

  it("stays silent when a tool really ran this turn", () => {
    expect(stripUnearnedWorkClaim(LIVE, { ranTool: true })).toBe(LIVE);
  });

  it("keeps a question ABOUT the owner (his business, not the agent's)", () => {
    for (const t of ["Lagi sibuk, atau finally santai?", "Lagi di kantor hari ini?", "Kamu lagi makan apa?"]) {
      expect(stripUnearnedWorkClaim(t)).toBe(t);
    }
  });

  it("keeps a plain statement that is not a claim of work in progress", () => {
    const t = "Besok pagi kamu mau ngopi lagi atau sekarang?";
    expect(stripUnearnedWorkClaim(t)).toBe(t);
  });

  it("leaves the text alone when cutting would leave a bare subject", () => {
    const t = "Aku lagi nyiapin sesuatu.";
    expect(stripUnearnedWorkClaim(t)).toBe(t);
  });

  it("does not fire on ordinary prose", () => {
    for (const t of ["Aku cekweather-nya besok ya.", "Besok pagi kita ngobrol lagi soal itinerary.", ""]) {
      expect(stripUnearnedWorkClaim(t)).toBe(t);
    }
  });
});

describe("dayPartAt — a pool line may never hardcode a time of day (live 2026-10-06 19:48)", () => {
  const at = (iso: string) => dayPartAt(new Date(iso).getTime());

  it("maps the four bands on WIB boundaries", () => {
    expect(at("2026-10-06T04:00:00+07:00")).toBe("pagi"); // 04:00
    expect(at("2026-10-06T10:59:00+07:00")).toBe("pagi");
    expect(at("2026-10-06T11:00:00+07:00")).toBe("siang");
    expect(at("2026-10-06T14:59:00+07:00")).toBe("siang");
    expect(at("2026-10-06T15:00:00+07:00")).toBe("sore");
    expect(at("2026-10-06T17:59:00+07:00")).toBe("sore");
    expect(at("2026-10-06T18:00:00+07:00")).toBe("malam");
  });

  it("reads the hour in Asia/Jakarta, not the host timezone", () => {
    // 23:30 UTC is already the next morning in WIB (+7).
    expect(at("2026-10-06T23:30:00Z")).toBe("pagi");
    // 02:00 UTC is 09:00 WIB - still pagi, though the host may see something else.
    expect(at("2026-10-07T02:00:00Z")).toBe("pagi");
  });

  it("is total: any input yields one of the four bands", () => {
    for (const h of [0, 3, 9, 12, 16, 21, 23]) {
      expect(["pagi", "siang", "sore", "malam"]).toContain(dayPartAt(new Date(2026, 9, 6, h).getTime()));
    }
  });
});

describe("thinGreetingRescue — the pool must agree with the clock (live 19:48 Michelle said 'sore' at 19:50)", () => {
  const base = { greetingTurn: true, agent: "michelle" as const, name: "Naufal" };

  it("greets by evening wording at 19:50, never 'sore'", () => {
    const at = new Date("2026-10-06T19:50:00+07:00").getTime();
    const out = thinGreetingRescue("Halo Mas Naufal.", { ...base, variant: 0, at });
    expect(out).toBe("Malam Mas Naufal, sudah makan? Kalau belum, aku bantu carikan yang deket.");
    expect(out).not.toMatch(/sore|pagi|siang/);
  });

  it("greets by morning wording at 08:05", () => {
    const at = new Date("2026-10-06T08:05:00+07:00").getTime();
    expect(thinGreetingRescue("Halo Mas Naufal.", { ...base, variant: 0, at })).toBe("Pagi Mas Naufal, udah sarapan? Aku juga masih fresh, gas aja.");
  });

  it("the whole pool is time-correct: no line may contain a foreign time word", () => {
    const at = new Date("2026-10-06T19:50:00+07:00").getTime();
    for (let variant = 0; variant < TRIO_GREETING_WARMUP.length; variant++) {
      const out = thinGreetingRescue("Halo Mas Naufal.", { ...base, variant, at });
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/\b(sore|pagi|siang)\b/);
      expect(out).toContain("Mas Naufal");
    }
  });

  it("keeps the two time-neutral lines neutral", () => {
    const at = new Date("2026-10-06T19:50:00+07:00").getTime();
    expect(thinGreetingRescue("Halo Mas Naufal.", { ...base, variant: 1, at })).toBe("Oh halo Mas Naufal. Lagi sibuk, atau finally santai?");
    expect(thinGreetingRescue("Halo Mas Naufal.", { ...base, variant: 2, at })).toBe("Hai Mas Naufal. Kabarnya gimana hari ini?");
  });

  it("still refuses the cases it always refused (Mia, unknown label, non-greeting, rich reply)", () => {
    const at = new Date("2026-10-06T19:50:00+07:00").getTime();
    expect(thinGreetingRescue("Halo Mas Naufal.", { ...base, agent: "mia", variant: 0, at })).toBe("Halo Mas Naufal.");
    expect(thinGreetingRescue("Halo Mas Naufal.", { ...base, agent: "zzz" as never, variant: 0, at })).toBe("Halo Mas Naufal.");
    expect(thinGreetingRescue("Halo Mas Naufal.", { ...base, greetingTurn: false, variant: 0, at })).toBe("Halo Mas Naufal.");
    const rich = "Halo Mas Naufal! Seneng banget kamu mampir, gimana kabarnya?";
    expect(thinGreetingRescue(rich, { ...base, variant: 0, at })).toBe(rich);
  });
});

describe("stripUnearnedWorkClaim — the reduplicated verb the live reply used (live 19:49)", () => {
  it("cuts the claim the verbatim live reply made", () => {
    expect(
      stripUnearnedWorkClaim("Halo Mas Naufal, aku lagi siap-siap buat ngecek data atau riset topik apa pun yang mau kita bahas sekarang.")
    ).toBe("Halo Mas Naufal.");
  });

  it("cuts other reduplicated and -di- forms the old list missed", () => {
    // The head must stay substantial (>=3 words); a bare "Aku" is refused on purpose.
    for (const t of [
      "Halo Mas Naufal, aku lagi siap2 buat data.",
      "Halo Mas Naufal, aku lagi nyari-nyari trending.",
      "Halo Mas Naufal, aku lagi dicek bahan reputación.",
      "Halo Mas Naufal, aku lagi ubah jadwalnya.",
    ]) {
      expect(stripUnearnedWorkClaim(t)).toBe("Halo Mas Naufal.");
    }
  });

  it("refuses when cutting would leave a bare subject (documented, not a bug)", () => {
    for (const t of ["Aku lagi siap2 buat data.", "Aku lagi nyiapin sesuatu."]) {
      expect(stripUnearnedWorkClaim(t)).toBe(t);
    }
  });

  it("keeps the OWNER's business out of scope (sibuk / di ... are not work claims)", () => {
    for (const t of ["Santai aja Mas Naufal, lagi apa nih?", "Lagi di kantor hari ini?", "Lagi sibuk, atau finally santai?"]) {
      expect(stripUnearnedWorkClaim(t)).toBe(t);
    }
  });

  it("stays silent once a tool really ran (opts.ranTool)", () => {
    const t = "Halo Mas Naufal, aku lagi siap-siap buat ngecek data.";
    expect(stripUnearnedWorkClaim(t, { ranTool: true })).toBe(t);
    expect(stripUnearnedWorkClaim(t, { ranTool: false })).toBe("Halo Mas Naufal.");
  });
});

describe("stripSelfIntroduction — Agnes naming herself (live 19:49)", () => {
  it("removes a sentence-initial self-intro (the live shape: it came after the greeting)", () => {
    expect(stripSelfIntroduction("Halo Mas Naufal. Aku Agnes, lagi siap-siap buat ngecek data.", { agent: "agnes" })).toBe(
      "Halo Mas Naufal. Lagi siap-siap buat ngecek data."
    );
  });

  it("removes a leading self-intro too", () => {
    expect(stripSelfIntroduction("Aku Michelle, siap bantu.", { agent: "michelle" })).toBe("Siap bantu.");
    // "Saya Agnes ya." would be left as the stub "Ya." - refused instead.
    expect(stripSelfIntroduction("Saya Agnes ya.", { agent: "agnes" })).toBe("Saya Agnes ya.");
  });

  it("re-capitalises the sentence that follows the removal", () => {
    expect(stripSelfIntroduction("Halo Mas Naufal. aku Michelle, cek kode dulu ya.", { agent: "michelle" })).toBe(
      "Halo Mas Naufal. Cek kode dulu ya."
    );
  });

  it("is trio-only: Mia, no label and an unknown label are byte-identical", () => {
    const t = "Halo Mas Naufal. Aku Agnes, siap.";
    for (const agent of ["mia", undefined, "zzz"]) {
      expect(stripSelfIntroduction(t, { agent: agent as never })).toBe(t);
    }
  });

  it("never leaves a stub: a self-intro that IS the sentence takes the sentence with it", () => {
    // "Halo Mas Naufal. Aku Agnes." -> the fragment sentence is dropped entirely.
    expect(stripSelfIntroduction("Halo Mas Naufal. Aku Agnes.", { agent: "agnes" })).toBe("Halo Mas Naufal.");
    expect(stripSelfIntroduction("Halo Mas Naufal! Aku Michelle", { agent: "michelle" })).toBe("Halo Mas Naufal!");
  });

  it("refuses when anything would be left shorter than a couple of words", () => {
    for (const t of ["Aku Agnes.", "Aku Michelle", "Aku Agnes ya."]) {
      expect(stripSelfIntroduction(t, { agent: "agnes" })).toBe(t);
    }
  });

  it("leaves ordinary first-person prose alone", () => {
    for (const t of ["Aku cek weather-nya besok ya.", "Aku ngerti kok.", "Aku mau tanya satu hal."]) {
      expect(stripSelfIntroduction(t, { agent: "agnes" })).toBe(t);
    }
  });
});

describe("the three 19:48 fixes compose on the verbatim live reply", () => {
  const AT = new Date("2026-10-06T19:50:00+07:00").getTime();
  const LIVE_AGNES = "Halo Mas Naufal. Aku Agnes, lagi siap-siap buat ngecek data atau riset topik apa pun yang mau kita bahas sekarang.";

  it("Agnes: claim cut -> self-intro stripped -> greeting warmed, correct hour", () => {
    const step1 = stripUnearnedWorkClaim(LIVE_AGNES);
    expect(step1).not.toContain("siap-siap");
    const step2 = stripSelfIntroduction(step1, { agent: "agnes" });
    expect(step2).not.toContain("Aku Agnes");
    const step3 = thinGreetingRescue(step2, { greetingTurn: true, agent: "agnes", name: "Naufal", variant: 0, at: AT });
    expect(step3).toBe("Malam Mas Naufal, sudah makan? Kalau belum, aku bantu carikan yang deket.");
  });

  it("Mia's own reply is untouched by all three trio-only guards", () => {
    const live = "Hai Mas Naufal! 🌸 Seneng banget kamu mampir nyapa kita bertiga di sini, gimana kabar harimu?";
    const s1 = stripUnearnedWorkClaim(live, { ranTool: true });
    const s2 = stripSelfIntroduction(s1, { agent: "mia" });
    expect(s2).toBe(live);
    expect(thinGreetingRescue(s2, { greetingTurn: true, agent: "mia", name: "Naufal", variant: 0, at: AT })).toBe(live);
  });
});
