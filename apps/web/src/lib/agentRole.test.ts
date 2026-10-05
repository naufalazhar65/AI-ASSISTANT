import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_PERSONA_VERSION,
  agentPersonaNeedsReseed,
  agentPersonaVersion,
  applyAgentRole,
  isAgentLabel,
  isEncyclopedicRegister,
  stripFormalRegisterFrame,
  stripMiaSignatureVoice,
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
