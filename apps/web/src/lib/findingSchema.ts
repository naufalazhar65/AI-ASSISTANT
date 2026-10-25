/**
 * Shared pentest finding schema — single source of truth for all skill outputs.
 *
 * Every skill in the Modular Pentest Skills System (recon, web, api, auth, access,
 * injection, logic, client, infra, reporting, verification, scope) produces findings
 * in this canonical shape. The store (`security.ts` Finding type) is a superset;
 * this schema is the contract between skills and the reporting layer.
 *
 * Keep in sync with:
 *   - security.ts `Finding` type (store)
 *   - reportHtml.ts parser (expects `## N. [SEV · CVSS x] title` + `- **Label**: value`)
 *   - submissionPreflight.ts (expects expected/actual/cvssVector/evidence)
 */

/** Canonical severity labels (ordered by impact). */
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Finding status lifecycle. */
export type FindingStatus = "open" | "resolved" | "duplicate" | "false_positive";

/** Evidence kind — what kind of proof backs this finding. */
export type EvidenceKind =
  | "http_request"      // raw HTTP request/response
  | "screenshot"        // browser screenshot
  | "poc_replay"        // poc_verify determinism result
  | "oast_callback"     // OAST DNS/HTTP callback
  | "static_analysis"   // code review / SAST
  | "manual"            // manual verification
  | "auto_evidence";    // auto-attached from http_history

/** Standardized finding — the contract every skill produces. */
export interface PentestFinding {
  // Identity
  id: string;                          // F-<timestamp>-<random>
  title: string;                       // concise, specific (e.g. "SQLi in /api/search via q param")
  skill: string;                       // which skill produced this (recon, web, api, auth, ...)
  target: string;                      // host or URL (normalized)

  // Classification
  severity: FindingSeverity;
  cvss: number | null;                 // CVSS v3.1 base score (0-10)
  cvssVector: string;                  // e.g. "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
  owasp: string;                       // OWASP Top 10 2025 category (e.g. "A03:2025")
  cwe: string;                         // CWE ID (e.g. "CWE-89")

  // Evidence (proof)
  evidence: string;                    // raw evidence (HTTP dump, screenshot ref, OAST callback)
  evidenceKind: EvidenceKind;
  steps: string;                       // steps to reproduce (numbered)
  pocVerified: boolean;                // poc_verify passed (determinism confirmed)
  pocTimes: number;                    // number of poc_verify replays

  // Impact & remediation
  impact: string;                      // business impact
  rootCause: string;                   // root cause analysis
  remediation: string;                 // fix recommendation
  expected: string;                    // expected behavior
  actual: string;                      // actual (vulnerable) behavior

  // Metadata
  references: string;                  // external references (CVE, CWE, OWASP, etc.)
  status: FindingStatus;
  createdAt: string;                   // ISO 8601
  resolvedAt?: string;
  tags: string[];                      // e.g. ["idor", "api", "auth-bypass"]
}

/** Minimal finding for skill routing decisions (no evidence). */
export interface SkillRouteContext {
  target: string;
  techStack: string[];                 // e.g. ["php", "mysql", "nginx"]
  surface: string[];                   // e.g. ["login", "api", "admin-panel"]
  hasAuth: boolean;
  hasApi: boolean;
  hasClientSide: boolean;
  hasCloud: boolean;
  scope: "lab" | "engagement" | "bug-bounty" | "public";
}

/** Skill routing result — which skills to activate. */
export interface SkillRouteResult {
  primary: string[];                   // skills to run first (ordered)
  secondary: string[];                 // skills to run after primary
  skipped: { skill: string; reason: string }[];
  reason: string;                      // human-readable routing explanation
}

/** The 12 core pentest skills. */
export const PENTEST_SKILLS = [
  "recon", "web", "api", "auth", "access", "injection",
  "logic", "client", "infra", "reporting", "verification", "scope",
] as const;
export type PentestSkill = (typeof PENTEST_SKILLS)[number];

/** Skill metadata for discovery. */
export interface SkillMeta {
  id: PentestSkill;
  title: string;
  description: string;
  tools: string[];
  whenToUse: string;
  rules: string[];
  owaspCategories: string[];
  priority: number;                    // 1 = highest (run first)
}

/** Default skill metadata (mirrors SKILL.md files). */
export const SKILL_REGISTRY: Record<PentestSkill, SkillMeta> = {
  recon: { id: "recon", title: "Recon", description: "Surface discovery and asset enumeration", tools: ["recon_subdomains", "recon_params", "recon_httpx", "content_discover", "js_mine", "js_deobfuscate"], whenToUse: "Start of any pentest engagement", rules: ["Passive sources open to any domain", "Active probing is scope-gated"], owaspCategories: [], priority: 1 },
  web: { id: "web", title: "Web", description: "Web vulnerability assessment (headers, cookies, TLS, CORS, CSP, cache)", tools: ["web_audit", "cors_audit", "csp_audit", "cache_decep", "cache_poison_prover", "bypass403", "open_redirect_chain", "host_header_hunt"], whenToUse: "After recon: testing web surface", rules: ["Start with passive web_audit", "All probes scope-gated"], owaspCategories: ["A05"], priority: 2 },
  api: { id: "api", title: "API", description: "API security testing (REST/GraphQL/OpenAPI)", tools: ["api_spec", "graphql_probe", "graphql_hunt", "api_hunt", "param_miner", "param_fuzz", "param_discover"], whenToUse: "When target exposes REST/GraphQL/OpenAPI", rules: ["api_spec requires JSON spec", "Active probing scope-gated"], owaspCategories: ["A01", "A07"], priority: 2 },
  auth: { id: "auth", title: "Auth", description: "Authentication security (login, JWT, OAuth, 2FA, ATO)", tools: ["auth_hunt", "jwt_attack", "oauth_hunt", "ato_prove", "auth_matrix", "otp_hunt", "otp_probe", "account_recovery", "session_fixation", "auth_setup"], whenToUse: "When target has authentication", rules: ["All probes scope-gated", "auth_setup requires real credentials"], owaspCategories: ["A07", "A01"], priority: 3 },
  access: { id: "access", title: "Access", description: "Access control testing (IDOR/BOLA, path traversal, privilege escalation)", tools: ["bola_diff", "auth_matrix", "path_traversal", "idor_enum", "bypass403", "exploit_chain"], whenToUse: "When target has user-specific resources", rules: ["bola_diff requires two sessions", "path_traversal is read-only"], owaspCategories: ["A01"], priority: 3 },
  injection: { id: "injection", title: "Injection", description: "Injection testing (SQLi, XSS, SSTI, XXE, CMDi, NoSQLi)", tools: ["param_fuzz", "sqlmap_scan", "nosql_hunt", "xss_hunt", "dom_taint", "dom_xss_prove", "ssti_enum", "blind_cmdi", "xxe_chain", "prototype_pollution"], whenToUse: "When target accepts user input", rules: ["param_fuzz is entry point", "poc_verify before finding_add"], owaspCategories: ["A03"], priority: 3 },
  logic: { id: "logic", title: "Logic", description: "Business logic testing (state-transition fuzzing, race conditions, CSRF)", tools: ["workflow_fuzz", "race_attack", "csrf_prove", "exploit_chain"], whenToUse: "When target has transactional flows", rules: ["workflow_fuzz requires happy-path flow", "race_attack uses nonce uniqueness"], owaspCategories: ["A04"], priority: 4 },
  client: { id: "client", title: "Client", description: "Client-side security (DOM XSS, prototype pollution, JS bundle analysis)", tools: ["dom_taint", "dom_xss_prove", "prototype_pollution", "xss_hunt", "js_mine", "js_deobfuscate"], whenToUse: "When target is a SPA or has heavy client-side JS", rules: ["dom_taint is static (verify manually)", "js_mine is read-only"], owaspCategories: ["A03"], priority: 4 },
  infra: { id: "infra", title: "Infra", description: "Infrastructure security (cloud, TLS, DNS, secrets, monitoring)", tools: ["cloud_misconfig", "tls_check", "dns_audit", "security_scan", "secret_scan", "bucket_enum", "recon_ports", "recon_dnsbrute"], whenToUse: "When target has cloud infrastructure", rules: ["cloud_misconfig requires engagement", "secret_scan walks sandbox only"], owaspCategories: ["A05"], priority: 5 },
  reporting: { id: "reporting", title: "Reporting", description: "Report generation and finding management", tools: ["report_generate", "report_save", "report_pdf", "writeup", "evidence_capture", "finding_add", "finding_list", "finding_resolve", "finding_export", "dup_check", "submission_track", "program_score"], whenToUse: "After testing: compile findings", rules: ["report_generate requires target param", "finding_add requires proof for high/critical"], owaspCategories: [], priority: 6 },
  verification: { id: "verification", title: "Verification", description: "Proof and verification (PoC replay, retest, CVSS, severity)", tools: ["poc_verify", "retest_run", "retest_add", "retest_list", "cvss_score", "platform_severity", "dup_check", "security_playbook"], whenToUse: "After finding a lead: prove determinism", rules: ["poc_verify before finding_add", "retest verifies fix"], owaspCategories: [], priority: 6 },
  scope: { id: "scope", title: "Scope", description: "Scope management (engagement, authorization, policy, lab registry)", tools: ["engagement_create", "engagement_list", "engagement_close", "engagement_targets", "scope_import", "policy_set", "policy_show", "lab_add"], whenToUse: "Before any pentest: define scope", rules: ["engagement_create requires authorization", "policy_set only read/write risk"], owaspCategories: [], priority: 0 },
};

/** Route a target context to the appropriate skills. */
export function routeSkills(ctx: SkillRouteContext): SkillRouteResult {
  const primary: string[] = [];
  const secondary: string[] = [];
  const skipped: { skill: string; reason: string }[] = [];

  // Scope always first
  primary.push("scope");

  // Recon always runs
  primary.push("recon");

  // Web: if HTTP surface exists (always for web targets)
  primary.push("web");

  // API: if API surface detected
  if (ctx.hasApi) {
    primary.push("api");
  } else {
    skipped.push({ skill: "api", reason: "No API surface detected (no OpenAPI spec, no /api/ endpoints)" });
  }

  // Auth: if authentication exists
  if (ctx.hasAuth) {
    primary.push("auth");
  } else {
    skipped.push({ skill: "auth", reason: "No authentication surface detected" });
  }

  // Access control: always relevant after auth
  if (ctx.hasAuth) {
    secondary.push("access");
  } else {
    skipped.push({ skill: "access", reason: "No auth → access control testing not applicable" });
  }

  // Injection: if user input exists (forms, params, search)
  if (ctx.surface.includes("search") || ctx.surface.includes("form") || ctx.surface.includes("input") || ctx.hasApi) {
    secondary.push("injection");
  } else {
    skipped.push({ skill: "injection", reason: "No user input surface detected" });
  }

  // Logic: if transactional flows exist
  if (ctx.surface.includes("checkout") || ctx.surface.includes("transfer") || ctx.surface.includes("payment") || ctx.surface.includes("cart")) {
    secondary.push("logic");
  } else {
    skipped.push({ skill: "logic", reason: "No transactional flow detected" });
  }

  // Client: if client-side heavy
  if (ctx.hasClientSide) {
    secondary.push("client");
  } else {
    skipped.push({ skill: "client", reason: "No heavy client-side JS detected" });
  }

  // Infra: if cloud infrastructure
  if (ctx.hasCloud) {
    secondary.push("infra");
  } else {
    skipped.push({ skill: "infra", reason: "No cloud infrastructure detected" });
  }

  // Verification: always available as secondary
  secondary.push("verification");

  // Reporting: always last
  secondary.push("reporting");

  return {
    primary,
    secondary,
    skipped,
    reason: `Routed ${primary.length} primary + ${secondary.length} secondary skills based on target context. ${skipped.length} skills skipped.`,
  };
}

