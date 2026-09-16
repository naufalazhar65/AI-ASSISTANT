// Shared memory hygiene — keep tool/command noise and secrets OUT of the
// human-facing memory surfaces (evening recap, weekly insight, daily memory).
//
// Why: daily memory stores each turn verbatim, so technical turns (GraphQL
// queries, pentest tool calls, tokens/ids) leaked into the "refleksi malam"
// recap — noisy and, worse, sensitive (a candidate id appeared in a push).
// One filter + one redactor, used everywhere, so the surfaces can't drift.

const NOISE_RE = new RegExp(
  [
    // tool/command names with snake_case (cdp_request, http_request, hunt_log…)
    "\\b[a-z]+_[a-z_]{2,}\\b",
    // GraphQL/JSON payload fragments (any JSON object with keys)
    "\\{\\s*\"(query|variables|data|operationName)\"",
    "[{\\[]\\s*\"[a-z_]{2,}\"\\s*:",
    "\\b(query|mutation|fragment)\\s*[{(]",
    // technical jargon that is never "what the human talked about"
    "\\b(graphql|introspection|subfield|payload|endpoint|mutation|objectidentifier|documentid|token_from|schema introspection)\\b",
    // shell/HTTP tooling
    "\\bcurl\\b|--data-raw|--header|method=(GET|POST|PUT|PATCH|DELETE)|token_from=|credentials=(omit|include)",
    "https?://\\S*(graphql|/api/|/v1/)",
    // shell/security tool names + host:port (never "what the human talked about")
    "\\b(nmap|nuclei|sqlmap|ffuf|nikto|gobuster|semgrep|trivy|zap|searchsploit|msfconsole|masscan|whatweb|httpx|katana|subfinder)\\b",
    "\\b\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?\\b|\\blocalhost:\\d+\\b",
    "\\b\\d+/tcp\\b|\\b\\d+/udp\\b",
    // HTML/markup payloads (lab XSS tests etc.) are not conversation.
    "<\\/?[a-z][a-z0-9]*[^>]{0,80}>|<script|javascript:|onerror=|onload=",
    // auth-ish identifiers
    "auth0\\|", "\\beyJ[A-Za-z0-9_-]{10,}", "\\bBearer\\s+\\S+", "\\bAKIA[0-9A-Z]{10,}", "\\bsk-[A-Za-z0-9]{12,}",
  ].join("|"),
  "i"
);

const SECRET_REDACT = [
  /auth0\|[A-Za-z0-9]+/gi,
  /\br(?:sk|ak)_[A-Za-z0-9]{10,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+\S+/gi,
  /\bAKIA[0-9A-Z]{10,}/g,
  /\bsk-[A-Za-z0-9]{12,}/g,
];

/**
 * True when a line is machine/technical noise rather than human conversation:
 * tool calls, payloads, shell/HTTP flags, auth ids. Pure — unit-tested.
 */
export function isNoiseLine(line: string): boolean {
  const t = (line || "").trim();
  if (!t) return true;
  // System bookkeeping written by schedulers, not the human.
  if (/^(resume|checkpoint)\b|lanjut dari checkpoint/i.test(t)) return true;
  // Code fences / bare language tags.
  if (/^```/.test(t) || /^(json|js|ts|bash|sh|python|html|css|xml|yaml)$/i.test(t)) return true;
  if (NOISE_RE.test(t)) return true;
  // Code-ish: two or more backticks (inline code / nmap output quoting).
  if ((t.match(/`/g) || []).length >= 2) return true;
  // A wall of non-space characters with no words is not a sentence.
  const longest = t.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
  if (longest >= 60 && t.length / (t.split(/\s+/).length || 1) > 25) return true;
  return false;
}

/** Mask secret-looking tokens so nothing sensitive is ever surfaced/stored. */
export function redactSecrets(text: string): string {
  let t = text || "";
  for (const re of SECRET_REDACT) t = t.replace(re, "[redacted]");
  // JSON-ish "secretKey": "value" → mask the value (any key naming a credential).
  t = t.replace(
    /("(?:[a-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|authorization|cookie|bearer|credential|signature)[a-z0-9_]*)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"'
  );
  return t;
}

/** Filter + redact a block of lines (used when appending/reading memory). */
export function cleanLines(lines: string[]): string[] {
  return lines.map((l) => redactSecrets(l.trim())).filter((l) => !isNoiseLine(l));
}
