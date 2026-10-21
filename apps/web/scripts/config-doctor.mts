/**
 * Config doctor — one command answers "why is Mia quiet?".
 *
 *   npx tsx apps/web/scripts/config-doctor.mts
 *
 * Read-only: it never writes, never calls the network, and never prints a
 * value. Only KEY NAMES and whether they are set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diagnoseConfig, renderConfigReport } from "../src/lib/configDoctor";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ENV_FILE = join(ROOT, "apps", "web", ".env.local");

/** Parse .env.local the same way the dashboard server does (key=value, # comment). */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function main(): void {
  const env = { ...readEnvFile(ENV_FILE), ...process.env };
  console.log("Kunci yang dibaca: .env.local + environment process.\n");
  console.log(renderConfigReport(diagnoseConfig(env)));
  console.log("\nPetunjuk: salin kunci yang hilang ke apps/web/.env.local, lalu restart Mia.");
}

main();
