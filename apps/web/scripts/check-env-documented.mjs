/**
 * Every env var the code reads must be documented in apps/web/.env.example.
 *
 *   node apps/web/scripts/check-env-documented.mjs
 *
 * Why this is a gate: the runtime reads ~130 env vars from a dozen modules,
 * and a key that is read but not documented is a key nobody can configure. The
 * gap that started this check was 46 keys wide (2026-10-21).
 *
 * Read-only. Prints the missing key names, never any value.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const WEB = join(ROOT, "apps", "web");
const DASH = join(ROOT, "apps", "office-dashboard");
const EXAMPLE = join(WEB, ".env.example");

/** Keys that are read but are NOT deployment configuration. */
const EXCLUDED = new Set([
  // Built by the runtime, not configured by a human.
  "HOME", "NODE_ENV", "NEXT_RUNTIME", "PORT", "PWD", "PATH", "USER", "SHELL",
  "TMPDIR", "LANG", "TERM", "JSON", "SHLVL", "HOSTNAME", "CI", "DEBUG",
  "NODE", "NPM", "SYSTEMROOT", "TMP", "TEMP", "USERPROFILE", "APPDATA",
  "PROGRAMFILES", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS", "GITHUB_ACTIONS", "RUNNER_OS", "AGENT_NAME",
  // Drill/probe plumbing: a drill sets these for itself, an operator never does.
  "OWNER_STORE_KEY", "DRILL_MODELS", "DRILL_RUNS",
]);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    // Vendored libraries are not our configuration surface — a key that
    // appears inside them is not something a human has to configure.
    if (name === "node_modules" || name === ".next" || name === ".data" || name === "vendor") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if ([".ts", ".tsx", ".mts", ".js", ".mjs"].includes(extname(name))) out.push(full);
  }
  return out;
}

/** The keys the code actually reads. */
function usedKeys(files) {
  const keys = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:process\.env\.|env\.)([A-Z][A-Z0-9_]+)/g)) keys.add(m[1]);
  }
  return keys;
}

/** The keys .env.example mentions (a commented line documents a key too). */
function documentedKeys(example) {
  const keys = new Set();
  for (const m of example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)) keys.add(m[1]);
  return keys;
}

const files = [
  ...walk(join(WEB, "src"), []),
  ...walk(join(WEB, "scripts"), []),
  ...walk(DASH, []),
];
for (const name of readdirSync(WEB)) {
  const full = join(WEB, name);
  if (statSync(full).isFile() && [".ts", ".mts"].includes(extname(name))) files.push(full);
}

const used = usedKeys(files);
const documented = documentedKeys(readFileSync(EXAMPLE, "utf8"));

const missing = [...used]
  .filter((k) => !documented.has(k) && !EXCLUDED.has(k))
  .filter((k) => !k.startsWith("PROBE_"))
  .sort();

if (missing.length) {
  console.error(`Env vars yang dipakai kode tapi TIDAK ada di apps/web/.env.example (${missing.length}):`);
  for (const k of missing) console.error(`  ${k}`);
  console.error("\nTambahkan setiap kunci ke .env.example dengan komentar yang menjelaskan gunanya.");
  process.exit(1);
}
console.log(`OK — ${used.size} env var dipakai kode, semua terdokumentasi di .env.example.`);
