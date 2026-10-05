import { describe, expect, it } from "vitest";
import { AGENT_PERSONA_VERSION, agentPersonaNeedsReseed, agentPersonaVersion, applyAgentRole, isAgentLabel, stripMiaSignatureVoice } from "./agentRole";
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
