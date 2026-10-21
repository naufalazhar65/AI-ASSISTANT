// configDoctor.ts — "why is Mia quiet?" in one command.
//
// The problem this solves: the runtime reads ~130 env vars scattered over a
// dozen modules, and every provider/channel has its own idea of which key
// makes it work. When Mia is silent, the first question is always the same —
// which key is missing? — and the answer used to be "read the source".
//
// This module is the single map from FEATURE to the key set that enables it.
// A feature is satisfied when AT LEAST ONE of its groups is fully present
// (groups are the alternatives the code itself accepts: Telegram answers to a
// bot token plus an allow-list in any of its three forms).
//
// It NEVER holds a value. Only key names leave this module, so a doctor
// report can be pasted into a chat without leaking a secret.

/** One feature: a title and the key groups that enable it. */
export interface ConfigFeature {
  id: string;
  title: string;
  /** Alternatives. The feature is ON when one group is fully present. */
  groups: string[][];
  /** One line about what the feature does — shown in the report. */
  note?: string;
}

/**
 * The feature map. Every group mirrors what the code actually requires, not
 * what looks tidy:
 *   - the brain: one of the four LLM providers (they are alternatives),
 *   - voice: Groq does STT+TTS, ElevenLabs only TTS,
 *   - Telegram: the bot refuses to answer without an owner allow-list, and
 *     the allow-list has three accepted shapes,
 *   - Slack: Socket Mode needs the app token next to the bot token.
 */
export const CONFIG_FEATURES: ConfigFeature[] = [
  {
    id: "llm",
    title: "Otak (LLM)",
    note: "satu dari empat provider",
    groups: [
      ["LLM_API_BASE", "LLM_API_KEY", "LLM_MODEL"],
      ["GROQ_API_KEY"],
      ["OPENCODEGO_API_KEY"],
      ["OPENROUTER_API_KEY"],
    ],
  },
  {
    id: "voice",
    title: "Suara (STT/TTS)",
    note: "Groq atau ElevenLabs",
    groups: [["GROQ_API_KEY"], ["ELEVENLABS_API_KEY"]],
  },
  {
    id: "telegram",
    title: "Telegram",
    groups: [
      ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERNAME"],
      ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID"],
      ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER"],
    ],
  },
  { id: "discord", title: "Discord", groups: [["DISCORD_BOT_TOKEN"]] },
  {
    id: "slack",
    title: "Slack",
    note: "Socket Mode butuh app token",
    groups: [["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]],
  },
  { id: "gmail", title: "Gmail", groups: [["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"]] },
  { id: "spotify", title: "Spotify", groups: [["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]] },
  { id: "live", title: "Live voice (Gemini)", groups: [["GEMINI_API_KEY"]] },
  {
    id: "dashboard",
    title: "Auth dashboard",
    groups: [["AUTH_TOKEN"], ["DASHBOARD_TOKEN"]],
  },
  { id: "webhook", title: "Webhook", groups: [["WEBHOOK_SECRET"]] },
  { id: "pentest", title: "Lab pentest", groups: [["PENTEST_LAB_TARGETS"]] },
];

/** A key counts as present only when it holds a real value. */
export function isPresent(env: Record<string, string | undefined>, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "";
}

export interface FeatureReport {
  id: string;
  title: string;
  note?: string;
  /** True when one of the groups is fully present. */
  on: boolean;
  /** Key names of the group that came closest to being satisfied. */
  missing: string[];
  /** Key names that ARE present (names only, never values). */
  present: string[];
}

/**
 * Build the report. For a feature that is off, the reported missing keys are
 * the ones from the CLOSEST group — the group a human would complete. That is
 * why the Telegram feature can say "TELEGRAM_ALLOWED_USERNAME" instead of
 * listing three alternative allow-lists.
 */
export function diagnoseConfig(
  env: Record<string, string | undefined>,
  features: ConfigFeature[] = CONFIG_FEATURES,
): FeatureReport[] {
  return features.map((feature) => {
    const present: string[] = [];
    let best: { missing: string[]; score: number } | null = null;
    for (const group of feature.groups) {
      const missing = group.filter((key) => !isPresent(env, key));
      if (missing.length === 0) {
        for (const key of group) present.push(key);
        return { id: feature.id, title: feature.title, note: feature.note, on: true, missing: [], present };
      }
      if (!best || missing.length < best.score) best = { missing, score: missing.length };
    }
    // Keys present in ANY group (they are set, just not the whole group).
    for (const group of feature.groups) {
      for (const key of group) {
        if (isPresent(env, key) && !present.includes(key)) present.push(key);
      }
    }
    return {
      id: feature.id,
      title: feature.title,
      note: feature.note,
      on: false,
      missing: best?.missing ?? [],
      present,
    };
  });
}

/** One line per feature: no values, only key names. */
export function renderConfigReport(reports: FeatureReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    const mark = report.on ? "ON " : "off";
    const detail = report.on
      ? report.present.join(", ")
      : report.missing.length
        ? `butuh: ${report.missing.join(", ")}`
        : "butuh: (tidak ada kelompok kunci)";
    const note = report.note ? ` — ${report.note}` : "";
    lines.push(`${mark}  ${report.title}${note}\n      ${detail}`);
  }
  const off = reports.filter((r) => !r.on).length;
  lines.push("");
  lines.push(`${reports.length - off} fitur aktif, ${off} fitur belum aktif.`);
  return lines.join("\n");
}
