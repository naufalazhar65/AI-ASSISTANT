/**
 * ROLE GATE — can an agent actually EXECUTE a tool that belongs to someone
 * else?
 *
 * Background (live 2026-10-04/05, Discord, real production path): all three
 * agents knew their roles perfectly and answered questions about them
 * correctly, yet nothing stopped an agent from running a tool outside its role.
 * The trio shares ONE tool window: `toolsForUrl(url)` in agent.ts takes only a
 * URL and has no agent parameter, so Mia, Agnes and Michelle all receive the
 * identical 64 tools. Role compliance was prompt-only.
 *
 * This module is the deterministic half of that contract. The prompt says who
 * owns what; this decides whether a call is allowed to run.
 *
 * DESIGN RULES (deliberate, do not "simplify" away):
 *
 * 1. FAIL OPEN. An unclassified tool is always allowed. A tool added next month
 *    keeps working without anyone remembering to classify it. The only thing
 *    denied is a call that is CLASSIFIED as another agent's territory.
 * 2. Mia is not gated. She is the generalist and the router; denying her would
 *    break the proven flows she owns (reminders, tasks, mail, mac control).
 * 3. Refuse loudly and honestly, never silently. The refusal text names the
 *    owner so the model hands the work over instead of retrying or inventing.
 */

import type { AgentLabel } from "./agentRole";

export type ToolDomain = "research" | "code" | "security" | "assistant";

/**
 * Which agent owns a tool. PARTIAL by design — an absent name means "nobody
 * claims it" and is therefore allowed for every agent (rule 1 above).
 *
 * Keep this table append-only and one-owner-per-tool: a tool listed twice with
 * different owners would make the gate depend on object key order.
 */
const TOOL_DOMAIN: Record<string, ToolDomain> = {
  // ── research: finding and verifying public facts ────────────────────────────
  web_search: "research",
  google_news: "research",
  research: "research",
  fetch_url: "research",
  browser_open: "research",
  browser_snapshot: "research",
  browser_navigate: "research",
  browser_click: "research",
  browser_type: "research",
  browser_eval: "research",
  browser_use_open: "research",
  browser_use_click: "research",
  browser_use_type: "research",
  browser_use_input: "research",
  browser_use_eval: "research",
  browser_use_scroll: "research",
  browser_use_tab: "research",
  browser_use_state: "research",
  browser_use_get: "research",
  browser_use_screenshot: "research",
  browser_use_doctor: "research",
  browser_use_keys: "research",
  browser_use_close: "research",
  browser_use_wait: "research",
  places_search: "research",
  hotel_search: "research",
  cinema_showtimes: "research",
  train_search: "research",
  // bus_search = BUS schedules (research), not the EventBus helper.
  bus_search: "research",
  gmaps_route: "research",
  waze_route: "research",
  weather: "research",
  hari_libur: "research",
  github_osint: "research",
  cve_intel: "research",
  ioc_extract: "research",
  breach_check: "research",
  dns_audit: "research",
  tls_check: "research",
  secret_scan: "research",
  security_scan: "research",
  dep_audit: "research",
  tech_watch: "research",
  content_discover: "research",
  crawl: "research",
  js_mine: "research",
  js_deobfuscate: "research",
  recon_subdomains: "research",
  recon_params: "research",
  recon_diff: "research",
  recon_ports: "research",
  recon_dnsbrute: "research",
  recon_takeover: "research",
  memory_where: "research",
  search_memory: "research",
  context_active: "research",

  // ── code: reading, writing and running things ───────────────────────────────
  file_read: "code",
  write_file: "code",
  edit_file: "code",
  exec: "code",
  exec_write: "code",
  safe_exec_list: "code",
  codebase_search: "code",
  codebase_refresh: "code",
  git_status: "code",
  git_commit: "code",
  hash_identify: "code",
  password_strength: "code",
  encoding: "code",
  calculate: "code",
  health: "code",
  list_uploads: "code",
  read_upload: "code",
  transcribe: "code",

  // ── security: testing an authorised target ──────────────────────────────────
  http_request: "security",
  http_session: "security",
  http_history: "security",
  pentest_scan: "security",
  pentest_resources: "security",
  security_hunt: "security",
  suite_hunt: "security",
  campaign_run: "security",
  bounty_run: "security",
  exploit_chain: "security",
  exploit_build: "security",
  vuln_compose: "security",
  workflow_fuzz: "security",
  flow_run: "security",
  flow_list: "security",
  request_run: "security",
  request_save: "security",
  poc_verify: "security",
  finding_add: "security",
  finding_list: "security",
  finding_resolve: "security",
  finding_export: "security",
  report_generate: "security",
  report_save: "security",
  report_pdf: "security",
  writeup: "security",
  coverage: "security",
  threat_model: "security",
  target_brain: "security",
  hunt_log: "security",
  retest_add: "security",
  retest_list: "security",
  retest_run: "security",
  auth_matrix: "security",
  auth_hunt: "security",
  api_hunt: "security",
  auth_setup: "security",
  ato_prove: "security",
  engagement_create: "security",
  engagement_close: "security",
  engagement_list: "security",
  engagement_targets: "security",
  policy_set: "security",
  policy_show: "security",
  lab_add: "security",
  lab_fetch: "security",
  lab_start: "security",
  lab_status: "security",
  evidence_capture: "security",
  tamper_script: "security",
  submission_track: "security",
  submission_preflight: "security",
  dup_check: "security",
  platform_severity: "security",
  program_score: "security",
  scope_import: "security",
  learning_ingest: "security",
  learning_query: "security",
  idor_enum: "security",
  bola_diff: "security",
  csrf_prove: "security",
  mass_assignment: "security",
  upload_fuzz: "security",
  param_fuzz: "security",
  param_miner: "security",
  param_discover: "security",
  path_traversal: "security",
  ssti_enum: "security",
  blind_cmdi: "security",
  blind_ssrf: "security",
  bypass403: "security",
  cache_decep: "security",
  cache_poison_prover: "security",
  nosql_hunt: "security",
  open_redirect_chain: "security",
  otp_hunt: "security",
  otp_probe: "security",
  proto_pollute: "security",
  account_recovery: "security",
  csv_inject: "security",
  race: "security",
  race_attack: "security",
  graphql_hunt: "security",
  graphql_probe: "security",
  xss_hunt: "security",
  xxe_chain: "security",
  smuggle_probe: "security",
  dom_taint: "security",
  dom_xss_prove: "security",
  prompt_injection_hunt: "security",
  llm_hunt: "security",
  mcp_hunt: "security",
  jwt_attack: "security",
  jwt_inspect: "security",
  oast_create: "security",
  oast_poll: "security",
  oast_stop: "security",
  oast_dns: "security",
  oast_dns_create: "security",
  oast_dns_poll: "security",
  oast_dns_stop: "security",
  exposure_hunt: "security",
  web_audit: "security",
  csp_audit: "security",
  cors_audit: "security",
  domain_audit: "security",
  recon_full: "security",
  recon_httpx: "security",
  recon_list: "security",
  recon_screenshot: "security",
  host_header_hunt: "security",
  sqlmap_scan: "security",
  nuclei_custom: "security",
  trivy_scan: "security",
  zap_scan: "security",
  sast_scan: "security",
  ws_hunt: "security",
  ws_probe: "security",
  teamcity_check: "security",
  hardening_plan: "security",
  hardening_pdf: "security",
  verify_patch: "security",
  bucket_enum: "security",
  cloud_misconfig: "security",
  oauth_hunt: "security",

  // ── assistant: the owner's everyday personal help ───────────────────────────
  remind_me: "assistant",
  reminders_list: "assistant",
  cancel_reminder: "assistant",
  reminders_mac_add: "assistant",
  reminders_mac_list: "assistant",
  reschedule_task: "assistant",
  add_task: "assistant",
  list_tasks: "assistant",
  complete_task: "assistant",
  cancel_task: "assistant",
  save_note: "assistant",
  list_notes: "assistant",
  delete_note: "assistant",
  mood_log: "assistant",
  // The owner's own inbox is personal assistance, not public-fact research —
  // and the Gmail prefetch in agent.ts is a SYSTEM call, so misclassifying it
  // as research would have blocked the feature for Agnes/Michelle.
  gmail_search: "assistant",
  gmail_read: "assistant",
  gmail_list: "assistant",
  gmail_link: "assistant",
  mood_recent: "assistant",
  habit_log: "assistant",
  habit_stats: "assistant",
  spotify_play: "assistant",
  spotify_pause: "assistant",
  spotify_next: "assistant",
  spotify_previous: "assistant",
  spotify_volume: "assistant",
  spotify_mode: "assistant",
  spotify_queue: "assistant",
  spotify_search: "assistant",
  spotify_status: "assistant",
  spotify_devices: "assistant",
  spotify_link: "assistant",
  spotify_sleep_timer: "assistant",
  calendar_add: "assistant",
  calendar_list: "assistant",
  calendar_check: "assistant",
  calendar_mac_add: "assistant",
  calendar_mac_list: "assistant",
  plan_create: "assistant",
  plan_list: "assistant",
  plan_get: "assistant",
  plan_add_step: "assistant",
  plan_update_step: "assistant",
  briefing: "assistant",
  recap: "assistant",
  weekly_insight: "assistant",
  library_list: "assistant",
  library_remove: "assistant",
  persona_show: "assistant",
  persona_set: "assistant",
  persona_forget: "assistant",
  send_channel: "assistant",
  memory: "assistant",
  memory_get: "assistant",
  memory_hygiene: "assistant",
  mac_open: "assistant",
  device_list: "assistant",
  device_battery: "assistant",
  device_exec: "assistant",
  device_screenshot: "assistant",
  device_camera: "assistant",
  device_location: "assistant",
  device_pair: "assistant",
  cua_doctor: "assistant",
  cua_list_apps: "assistant",
  cua_window_state: "assistant",
  cua_desktop: "assistant",
  cua_click: "assistant",
  cua_type: "assistant",
  cua_keys: "assistant",
  cua_mouse: "assistant",
  cua_pointer: "assistant",
  cua_screen: "assistant",
  cua_launch: "assistant",
  cua_browser_state: "assistant",
  cua_browser_click: "assistant",
  cua_browser_type: "assistant",
  clipboard_get: "assistant",
  clipboard_set: "assistant",
  cdp_status: "assistant",
  cdp_open: "assistant",
  cdp_eval: "assistant",
  cdp_request: "assistant",
  cdp_proxy: "assistant",
  summarize: "assistant",
  humanize: "assistant",
  mala: "assistant",
  auto_update: "assistant",
  auto_update_status: "assistant",
  provider_status: "assistant",
  freeride_status: "assistant",
  freeride_list: "assistant",
  freeride_switch: "assistant",
  freeride_auto: "assistant",
  freeride_rotate: "assistant",
  freeride_refresh: "assistant",
  freeride_watcher: "assistant",
  skill_search: "assistant",
  skill_list: "assistant",
};

/** Domains each gated agent may run. Anything owned elsewhere is refused. */
const AGENT_DOMAINS: Partial<Record<AgentLabel, readonly ToolDomain[]>> = {
  agnes: ["research"],
  michelle: ["code", "security"],
  // Mia intentionally absent — see rule 2 in the file header.
};

const DOMAIN_LABEL: Record<ToolDomain, string> = {
  research: "research and fact-checking",
  code: "reading and writing files, running commands and tests",
  security: "security testing of an authorised target",
  assistant: "reminders, tasks, notes, mail, music and everyday personal help",
};

/** The agent that owns a domain, named for the refusal message. */
const DOMAIN_OWNER: Record<ToolDomain, string> = {
  research: "Agnes",
  code: "Michelle",
  security: "Michelle",
  assistant: "Mia",
};

export function toolDomain(name: string): ToolDomain | undefined {
  return TOOL_DOMAIN[name];
}

export function agentDomains(agent: string | undefined): readonly ToolDomain[] | undefined {
  if (!agent || (agent !== "agnes" && agent !== "michelle")) return undefined;
  return AGENT_DOMAINS[agent];
}

/**
 * Decide whether `agent` may run `toolName`.
 *
 * Returns null when the call is allowed, or an honest refusal string that names
 * the owner so the agent hands the work over instead of retrying. Never throws.
 */
export function roleGateRefusal(agent: string | undefined, toolName: string): string | null {
  const allowed = agentDomains(agent);
  if (!allowed) return null; // fail open (rules 1 and 2)

  const domain = TOOL_DOMAIN[toolName];
  if (!domain) return null; // unclassified → allowed (rule 1)
  if (allowed.includes(domain)) return null;

  const owner = DOMAIN_OWNER[domain];
  return (
    `Not your tool: \`${toolName}\` belongs to ${owner} (${DOMAIN_LABEL[domain]}). ` +
    `Your role does not cover it, so it was NOT run — do not claim it was done. ` +
    `Tell the owner this is ${owner}'s work and stop.`
  );
}

/** Test/diagnostic helper: every tool name the gate has classified. */
export function classifiedToolNames(): string[] {
  return Object.keys(TOOL_DOMAIN);
}