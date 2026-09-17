// "Where do you keep your memory?" — answered from the real storage layout
// instead of the model's imagination. Lists the per-user stores that exist right
// now, with counts, so the answer is verifiable (and stays true if a store is
// added or empty). Read-only; paths are relative to the user's data folder.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { readFindings } from "./security";

type Store = { label: string; rel: string; what: string; count: string };

function countJsonArray(path: string, filter?: (row: Record<string, unknown>) => boolean): number | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const arr = Array.isArray(j) ? j : Array.isArray((j as { rows?: unknown[] })?.rows) ? (j as { rows: unknown[] }).rows : null;
    if (!arr) return null;
    const rows = arr.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
    return (filter ? rows.filter(filter) : rows).length;
  } catch {
    return null;
  }
}

/** Human-readable map of THIS user's memory stores (only the ones that exist). */
export function memoryWhere(rawUser: unknown): string {
  const user = sanitizeUser(rawUser);
  if (!user) return "Error: user tidak dikenali.";
  const root = join(userDataRoot(), user);
  if (!existsSync(root)) return `Belum ada apa pun yang tersimpan untuk \`${user}\` — belum ada yang bisa kutunjukkan.`;
  const rel = (p: string) => join(".data/users", user, p);
  const stores: Store[] = [];

  // Persona: stable facts + style, split per concern.
  const personaDir = join(root, "persona");
  if (existsSync(personaDir)) {
    const files = readdirSync(personaDir).filter((f) => f.endsWith(".md"));
    const userMd = join(personaDir, "USER.md");
    let facts = 0;
    try {
      facts = (readFileSync(userMd, "utf8").match(/^-\s+\S+/gm) || []).length;
    } catch {
      /* no USER.md yet */
    }
    stores.push({
      label: "Fakta & gaya (persona)",
      rel: rel("persona/"),
      what: `fakta stabil (nama, kota, hobi…), gaya bicara; ${files.join(", ")}`,
      count: `${facts} fakta`,
    });
  }

  // Daily memory: one markdown file per day (also the RAG source).
  const memDir = join(root, "memory");
  if (existsSync(memDir)) {
    const files = readdirSync(memDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    stores.push({
      label: "Catatan harian",
      rel: rel("memory/"),
      what: "ringkasan tiap obrolan per tanggal (dipakai search_memory)",
      count: `${files.length} hari${files.length ? `, terakhir ${files[files.length - 1].replace(".md", "")}` : ""}`,
    });
  }

  // Per-user JSON stores: only report the ones present, with counts.
  const json: [string, string, string, string | number | null][] = [
    ["notes.json", "Catatan", "note yang kamu minta kucatat", countJsonArray(join(root, "notes.json"))],
    ["tasks.json", "Tugas", "daftar tugas + status", countJsonArray(join(root, "tasks.json"))],
    ["reminders.json", "Reminder", "pengingat terjadwal + status terkirim", countJsonArray(join(root, "reminders.json"))],
    ["moods.json", "Mood", "catatan suasana hati per hari", countJsonArray(join(root, "moods.json"))],
    ["health.json", "Kesehatan", "air minum & jam tidur", null],
    ["corrections.json", "Koreksi", "hal yang pernah kamu koreksi dari aku", countJsonArray(join(root, "corrections.json"))],
    ["automations.json", "Automation", "tugas terjadwal yang kamu minta", countJsonArray(join(root, "automations.json"))],
    ["hunt-state.json", "Hunt log", "status target pentest (lead/dead/finding)", countJsonArray(join(root, "hunt-state.json"))],
    ["http-sessions.json", "Sesi HTTP", "cookie/header tersimpan untuk uji terautentikasi", null],
    ["sleep.json", "Jam tidur", "rekap tidur harian", countJsonArray(join(root, "sleep.json"))],
  ];
  for (const [file, label, what, n] of json) {
    if (!existsSync(join(root, file))) continue;
    stores.push({ label, rel: rel(file), what, count: n === null ? "ada" : `${n} entri` });
  }

  // Findings + reports live in their own shapes.
  try {
    const findings = readFindings(user);
    const open = findings.filter((f) => f.status !== "resolved").length;
    if (findings.length) stores.push({ label: "Temuan pentest", rel: rel("findings.json"), what: "temuan + bukti + status", count: `${open} terbuka / ${findings.length} total` });
  } catch {
    /* best-effort */
  }
  const uploads = join(root, "uploads");
  if (existsSync(uploads) && statSync(uploads).isDirectory()) {
    stores.push({ label: "Upload", rel: rel("uploads/"), what: "file yang kamu kirim", count: `${readdirSync(uploads).length} file` });
  }

  if (!stores.length) return `Belum ada apa pun yang tersimpan untuk \`${user}\` — belum ada yang bisa kutunjukkan.`;
  const lines = stores.map((s) => `• ${s.label} — \`${s.rel}\` (${s.count})\n   ${s.what}`);
  return `🧠 Di mana aku menyimpan memori tentang kamu (lokal, folder \`.data/users/${user}/\`):\n\n${lines.join("\n")}\n\nPersona (fakta & gaya) adalah sumber utama; catatan harian dipakai untuk mengingat konteks. Tool lain: memory_get (hari tertentu), search_memory (cari), persona_show (fakta), memory (catatan jangka panjang).`;
}
