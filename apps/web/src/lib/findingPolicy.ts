// findingPolicy.ts — the ONE owner of "what does a finding of this CLASS
// legitimately claim?", used by the report, the submission writeup and the
// preflight check. Pure — unit-tested.
//
// Why this module exists (bounty-audit 2026-09-28): §4.2 (Expected vs Actual)
// was a dead template because nothing ever populated the fields, so the writeup
// fell back to a single hardcoded authentication sentence that was printed for
// EVERY class — an XSS submission claiming "returns HTTP 200 with the sensitive
// record without authentication" is worse than no section at all, because a
// triager reads it and stops trusting the report. §6 (remediation) had the same
// shape: `"fix per category A03:2025"` is not a fix.
//
// Two rules this file follows:
//   1. A baseline is a CLASS-SPECIFIC floor, never a claim. It says what correct
//      behaviour is (expected) and what the test observed (actual) for that
//      class; it never invents scope, and it never asserts an outcome the tester
//      did not see.
//   2. When a class is unknown, the honest answer is to OMIT the section. A
//      missing Expected/Actual is a gap the model can fix; a wrong one is a
//      fabricated finding. So `expectedActualFor` returns null rather than a
//      default sentence, and callers skip the section.

/** Normalised vulnerability classes the baselines are keyed by. */
export type VulnClass =
  | "sqli"
  | "nosql"
  | "command-injection"
  | "ssti"
  | "xss"
  | "csrf"
  | "ssrf"
  | "xxe"
  | "path-traversal"
  | "idor"
  | "broken-auth"
  | "open-redirect"
  | "jwt"
  | "cors"
  | "mass-assignment"
  | "info-disclosure"
  | "rce"
  | "other";

type ClassFacts = { title: string; cwe: string; owasp: string };

/**
 * Title vocabulary per class, ordered most-specific first: the first pattern
 * that matches wins, so "SQL injection" never reads as generic info-disclosure
 * and a "reflected XSS in the search box" is classified by what it IS (xss),
 * not by the box it was found in.
 *
 * CWE is the strongest signal and is checked first; OWASP is only trusted when
 * the title is also specific (same rule as findingGate's injection class) so a
 * bare "A03:2025" label on a non-injection bug cannot misclassify it.
 */
const CLASS_ORDER: ReadonlyArray<{ cls: VulnClass; cwe?: RegExp; title: RegExp; owasp?: RegExp }> = [
  // --- code / command execution classes first: they read as "injection" broadly
  { cls: "sqli", cwe: /\bCWE-89\b/i, title: /\b(sql[\s-]?injection|sqli|sql[\s-]?i)\b/i, owasp: /injection/i },
  { cls: "nosql", cwe: /\bCWE-943\b/i, title: /\b(no[\s-]?sql|nosql|mongo(?:db)? injection|operator injection)\b/i },
  { cls: "command-injection", cwe: /\bCWE-?(?:78|77|88|94|95|96)\b/i, title: /\b(command[\s-]?injection|os command|shell[\s-]?injection|cmdi|argument injection)\b/i },
  { cls: "ssti", cwe: /\bCWE-(?:1336|1337|94)\b/i, title: /\b(ssti|template injection|server[\s-]?side template|expression language injection)\b/i },
  { cls: "xxe", cwe: /\bCWE-611\b/i, title: /\b(xxe|xml external entit|external entit)/i, owasp: /injection/i },
  { cls: "xss", cwe: /\bCWE-79\b/i, title: /\b(xss|cross[\s-]?site scripting|html injection|dom xss|stored xss|reflected xss)\b/i },
  { cls: "csrf", cwe: /\bCWE-352\b/i, title: /\b(csrf|cross[\s-]?site request forgery|xsrf)\b/i },
  { cls: "ssrf", cwe: /\bCWE-918\b/i, title: /\b(ssrf|server[\s-]?side request forgery|blind ssrf)\b/i },
  { cls: "path-traversal", cwe: /\bCWE-(?:22|23|36|73|98)\b/i, title: /\b(path traversal|directory traversal|local file inclusion|lfi|arbitrary file (?:read|include)|zip slip)\b/i },
  { cls: "mass-assignment", cwe: /\bCWE-915\b/i, title: /\b(mass assignment|over[- ]posting|property injection|parameter tampering)\b/i },
  { cls: "jwt", cwe: /\bCWE-(?:347|259|327|613|345)\b/i, title: /\b(jwt|json web token|token (?:verification|forgery|signature)|alg[ :]none)\b/i },
  { cls: "open-redirect", cwe: /\bCWE-601\b/i, title: /\b(open redirect|unvalidated redirect|redirect (?:url )?manipulation)\b/i },
  { cls: "cors", cwe: /\bCWE-942\b/i, title: /\b(cors|cross[\s-]?origin resource sharing|wildcard origin|origin reflection)\b/i },
  { cls: "idor", cwe: /\bCWE-(?:639|862|863|284)\b/i, title: /\b(idor|insecure direct object|object reference|bola|broken object level authorization|broken function level authorization|bfla|privilege escalation|horizontal privilege|vertical privilege)\b/i },
  { cls: "broken-auth", cwe: /\bCWE-(?:287|306|384|521|613|620|640|798)\b/i, title: /\b(authentication (?:bypass|weakness|flaw)|broken authentication|auth bypass|account takeover|weak (?:session|login|password)|credential stuffing|brute force|missing authentication|authorization bypass|improper authorization|access control)\b/i },
  { cls: "info-disclosure", cwe: /\bCWE-(?:200|203|209|532|538|548|1004|1021|1173|2000)\b/i, title: /\b(information (?:disclosure|exposure)|sensitive (?:data|information)|disclos|leak\w*\s+(?:of\s+)?(?:internal|private|user)|stack trace|debug (?:mode|information)|verbose error|missing (?:httponly|httponly|secure)|cookie (?:without|missing)|error message|directory (?:listing|browsing)|server banner|version disclosure)\b/i },
  // RCE is deliberately LAST of the "real" classes: a claim of RCE is a
  // CONSEQUENCE of one of the classes above, so it must never shadow the
  // underlying class when the report asks "what should correct behaviour be".
  { cls: "rce", title: /\b(rce|remote code execution|arbitrary code execution|full remote code)\b/i },
];

/** Normalised class of a finding. Pure. */
export function vulnClass(f: ClassFacts): VulnClass {
  const title = String(f.title || "");
  const cwe = String(f.cwe || "");
  const owasp = String(f.owasp || "");
  for (const entry of CLASS_ORDER) {
    if (entry.cwe && entry.cwe.test(cwe)) return entry.cls;
    if (entry.title.test(title)) return entry.cls;
    if (entry.owasp && entry.owasp.test(owasp) && entry.title.test(title)) return entry.cls;
  }
  return "other";
}

type Baseline = { expected: string; actual: string; remediation: string };

/**
 * Class baselines. `expected` = what a correct system does; `actual` = the
 * behaviour the class is defined by (still phrased so the tester must match it
 * to their own observation — the writeup prints the tester's `actual` when
 * present and only falls back to this). `remediation` = the minimum fix that
 * actually closes the class, not a category name.
 */
const BASELINES: Record<Exclude<VulnClass, "other">, Baseline> = {
  sqli: {
    expected: "The endpoint should treat request parameters as data, not SQL, and must not alter the query structure, return extra rows, or return database error detail.",
    actual: "A crafted parameter changed the result set (extra rows returned / boolean condition honoured) or produced a database error, proving the parameter is concatenated into the query.",
    remediation: "Use parameterised queries or prepared statements for every value; never build SQL by string concatenation; run the account with least-privilege read-only rights on the affected tables; return generic errors and log the detail server-side.",
  },
  nosql: {
    expected: "Authentication and query parameters should be type-validated before they reach the database driver, so an object or operator can never be interpreted as a query condition.",
    actual: "Sending a NoSQL operator (e.g. $ne/$gt/$regex) or an object instead of a scalar value changed the match result, so the driver evaluated it as a query expression.",
    remediation: "Validate the request value's type before querying (reject objects/arrays for scalar fields); cast to the expected primitive; run the query through an ODM that does not evaluate operators from user input; apply least privilege to the database role.",
  },
  "command-injection": {
    expected: "User input must never reach a shell command; the application should invoke the underlying program with an argument array and no shell interpretation.",
    actual: "Input containing shell metacharacters (e.g. ; | & $() `) altered command execution — observed either in the response/output or through a blind out-of-band callback fired by the injected command.",
    remediation: "Replace shell invocation with execFile/spawn using an argument array (no shell: true); allow-list the permitted subcommands and arguments; drop privileges of the service account; never interpolate request data into a command string.",
  },
  ssti: {
    expected: "User input should be passed to the template engine as data, so template/expression syntax is rendered literally instead of evaluated.",
    actual: "Template syntax in the input was evaluated by the engine (arithmetic, string repetition or a template-specific side effect changed in the output), confirming the input reaches the template as code.",
    remediation: "Render user-supplied strings as data (contextual auto-escaping) and never pass raw request values into a template source; if templating is unavoidable use a sandboxed logic-less engine; verify the fingerprint (engine + version) and upgrade to a patched release.",
  },
  xss: {
    expected: "The application should encode untrusted data for its output context, so injected markup is displayed as text and never parsed as HTML/script.",
    actual: "Injected markup was stored and/or reflected, and executed in the victim's browser context (handler fired / DOM sink reached), so the injected script runs with the application's origin.",
    remediation: "Apply context-aware output encoding at every sink; sanitise stored HTML with a maintained allow-list sanitiser (e.g. DOMPurify) before persisting; deploy a strict Content-Security-Policy that blocks inline and untrusted script sources; set cookies HttpOnly+Secure+SameSite so injected script cannot exfiltrate the session.",
  },
  csrf: {
    expected: "State-changing requests should require a per-session anti-CSRF token (or another same-origin proof such as SameSite cookies plus an origin check) so a third-party page cannot trigger them.",
    actual: "A cross-origin form/fetch triggered the state-changing request and the action completed, without a valid anti-CSRF token being required.",
    remediation: "Require an unpredictable, session-bound anti-CSRF token on every state-changing request and validate it server-side; verify Origin/Referer on those requests; set session cookies SameSite=Lax/Strict, Secure and HttpOnly; never rely on a custom header alone without a CORS policy that forbids foreign origins.",
  },
  ssrf: {
    expected: "The server should only fetch destinations from an allow-list of trusted schemes/hosts, and must block access to loopback, link-local/metadata and private network ranges.",
    actual: "A user-supplied URL caused the server to issue a request to a non-public destination (observed in the response, in proxy logs, or through an out-of-band callback from the internal target), proving the server fetches attacker-chosen destinations.",
    remediation: "Allow-list outbound destinations (scheme + host + port) and resolve the hostname before connecting to defeat DNS rebinding; block loopback, private, link-local and cloud metadata ranges (169.254.169.254); disable HTTP redirects during the fetch; require the destination to be an identifier, not a full URL, wherever possible.",
  },
  xxe: {
    expected: "The XML parser should run with external entity resolution and DTD processing disabled, so an entity declaration cannot cause the parser to read local files or open outbound connections.",
    actual: "The parser resolved an injected entity — a local file's content appeared in the response, or an out-of-band callback carried the entity content, proving external entities are processed.",
    remediation: "Disable DTD processing and external entity resolution in the parser configuration (e.g. disallow-doctype-decl, no external general/parameter entities); if the document format allows, migrate to JSON; validate and canonicalise the input; run the service with read-only filesystem access and an outbound-deny egress policy.",
  },
  "path-traversal": {
    expected: "The application should resolve the requested file against a fixed base directory and reject any resolved path that escapes it, so no file outside the intended directory can be read.",
    actual: "A relative/encoded path (../, %2e%2e/, absolute path, php://filter, archive member) escaped the intended directory and the server returned a file (or its decoded source) that should not be reachable.",
    remediation: "Resolve the path and verify the canonical result is inside the allowed base directory (reject on escape, don't sanitise by stripping); allow-list the identifiers/files that may be requested instead of accepting paths; disable directory listings; run the service with least-privilege filesystem permissions; keep the vulnerable parser/framework patched.",
  },
  idor: {
    expected: "The server should authorise every request against the authenticated identity, so an object belonging to another user is never returned regardless of the identifier supplied.",
    actual: "Requesting the object with a different user's identifier (or no session) returned that object's data, so authorisation is decided by client-supplied input rather than by the session.",
    remediation: "Authorise on the server for every request by deriving the subject from the session, never from a client-supplied id; scope all data access by owner/tenant in the query itself; return 404 (not 403) for objects the caller may not see; add a regression test that asserts cross-account access fails.",
  },
  "broken-auth": {
    expected: "Authentication and session handling should be enforced server-side on every request, with credentials verified against a stored hash and authorisation checked for the specific action.",
    actual: "A request that should have required a valid session/role/ownership check completed without it, or credentials were accepted/derived from a predictable or public value.",
    remediation: "Enforce authentication and authorisation server-side on every endpoint (deny by default); hash passwords with a memory-hard KDF (argon2id/bcrypt) and never store or log raw credentials; rotate and expire sessions, invalidate on privilege change, and bind authorisation decisions to the session subject rather than client input; add rate limiting and lockout on credential endpoints.",
  },
  "open-redirect": {
    expected: "The application should only redirect to destinations on an allow-list (or same-origin relative paths), so a third-party URL supplied by the user can never be used as a redirect target.",
    actual: "A crafted parameter caused the application to respond with a redirect to an attacker-controlled host, so the trusted domain can be used to land users on a phishing page.",
    remediation: "Allow-list redirect targets or accept only same-origin relative paths; reject absolute URLs and scheme-relative //host forms; never reflect the request's Host header into a redirect; consider a signed/opaque redirect token for flows that need to carry state.",
  },
  jwt: {
    expected: "The server should verify the token's signature with a pinned algorithm and key, validate issuer/audience/expiry, and never trust the token's own header to choose the verification method.",
    actual: "A forged or tampered token was accepted (e.g. alg=none, HS/RS key confusion, an attacker-controlled jku/kid, or missing expiry validation), so the application authenticated a token it never cryptographically verified.",
    remediation: "Pin the expected algorithm and verify the signature against an explicitly configured key (never from the token header or a jku URL); validate iss, aud, exp and nbf on every request; restrict kid to a known-key lookup (no path traversal / no raw query); rotate signing keys with a key id scheme and reject unknown ids; keep the JWT library patched.",
  },
  cors: {
    expected: "The application should only return Access-Control-Allow-Origin for origins on an allow-list, and should never combine a reflected origin with Access-Control-Allow-Credentials: true.",
    actual: "An arbitrary/attacker origin was reflected in Access-Control-Allow-Origin (often with Allow-Credentials: true), so a cross-origin page can read authenticated responses.",
    remediation: "Return a fixed allow-list of trusted origins; never reflect the Origin header without validating it against that list; do not send Access-Control-Allow-Credentials together with a wildcard or reflected origin; restrict Access-Control-Allow-Methods/Headers to what the app actually needs; set Vary: Origin correctly for caches.",
  },
  "mass-assignment": {
    expected: "The API should bind only the fields the client is allowed to change, so a request cannot set privileged or server-controlled attributes.",
    actual: "Adding extra fields to the request body set server-side attributes (role, isAdmin, verified, balance, ownerId), so the client controls data the API never meant to expose.",
    remediation: "Bind to an explicit per-endpoint DTO/allow-list of writable fields (never bind to the model directly); reject unknown/forbidden properties instead of ignoring them; set ownership and privilege fields server-side; add a schema validation layer (e.g. allow-strict JSON schema) at the API boundary.",
  },
  "info-disclosure": {
    expected: "The endpoint should return only the data the caller is authorised to see, and should not expose records, internals or personal data belonging to other subjects.",
    actual: "The response contained data the caller should not receive (records of other users/subjects, internal paths, stack traces, keys or personal identifiers) beyond what the feature requires.",
    remediation: "Scope the response to the requesting subject and return only the fields the feature needs; remove sensitive fields from serialisation (allow-list, not deny-list); keep secrets, stack traces and internal identifiers out of responses; review the endpoint's data-access layer for missing ownership filters.",
  },
  rce: {
    expected: "The application should not allow request data to become executable code; the requested operation should be performed by a fixed code path, not by evaluating input.",
    actual: "Request-supplied input reached a code-execution primitive (an interpreter, deserialiser or command) and code from the request ran on the server.",
    remediation: "Remove the code-execution primitive from the request path; if dynamic evaluation is required, restrict it to a safe subset with a strict input contract; patch or remove the affected component; sandbox and drop privileges for the service, and add egress controls so a compromised worker cannot reach the internal network.",
  },
};

/** True when the string is a placeholder rather than a real fix. Pure. */
export function isGenericRemediation(text: string): boolean {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  return (
    t.length < 25 ||
    /^fix per category\b/.test(t) ||
    /^(n\/a|tbd|todo|fix it|perbaiki|perbaiki bugs|see above)\b/.test(t) ||
    /^(fix|patch|update|upgrade|change|modify|validate|use https|use prepared)\b[\s.]*$/.test(t) ||
    // Advice that names no file, no check and no code path. Caught by the test
    // suite because this is the exact sentence the old writeup fallback printed
    // for EVERY finding — leaving it unrecognised would let boilerplate keep
    // reading as a finding-specific fix.
    /\b(enforce|validate|sanitize|escape|harden)[a-z]*\b[^.]{0,60}\bserver[- ]side\b/.test(t) ||
    /\bnever trust (client|user)[- ]supplied\b/.test(t)
  );
}

/**
 * The Expected/Actual pair for a finding: the tester's own `actual` wins; the
 * expected side falls back to the class baseline. Returns null when the class
 * is unknown AND the tester supplied nothing — the caller then omits the
 * sections rather than printing a sentence that may be wrong.
 */
export function expectedActualFor(f: ClassFacts & { expected?: string; actual?: string }): { expected: string; actual: string } | null {
  const expected = String(f.expected || "").trim();
  const actual = String(f.actual || "").trim();
  const cls = vulnClass(f);
  const base = cls === "other" ? null : BASELINES[cls];
  if (!expected && !actual && !base) return null;
  return {
    expected: expected || (base ? base.expected : ""),
    actual: actual || (base ? base.actual : ""),
  };
}

/**
 * Remediation for the report: the tester's prose when it is a real fix, else the
 * class baseline. `source` tells the caller which one it got so a report can
 * label a machine baseline honestly instead of passing it off as the tester's
 * own words.
 */
export function remediationFor(f: ClassFacts & { remediation?: string }): { text: string; source: "tester" | "baseline" } {
  const own = String(f.remediation || "").trim();
  if (own && !isGenericRemediation(own)) return { text: own, source: "tester" };
  const cls = vulnClass(f);
  if (cls !== "other") return { text: BASELINES[cls].remediation, source: "baseline" };
  return {
    text: own || "State the specific code/config change that closes this issue: which check is missing, where it must be enforced, and what the correct behaviour is.",
    source: "tester",
  };
}

/** The CVSS version a vector declares; v3.1 when nothing is recorded. Pure. */
export function cvssVersionFor(vector?: string): "4.0" | "3.1" {
  return /^\s*CVSS:\s*4(?:\.\d)?\//i.test(String(vector || "")) ? "4.0" : "3.1";
}

/**
 * Class synonyms used ONLY to normalise a near-identical re-worded title, so
 * "SQLi in /x" and "SQL injection on /x" collide in the duplicate guard.
 * Deliberately intra-class: a genuine class change (path traversal vs LFI,
 * IDOR vs auth bypass) must stay two findings.
 */
const CLASS_SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  [/\b(sql injection|sqli)\b/g, "sqlclassinjection"],
  [/\b(no sql injection|nosql injection|nosqli)\b/g, "nosqlclassinjection"],
  [/\b(cross site scripting|cross site|xss)\b/g, "xssclass"],
  [/\b(insecure direct object reference|idor|bola)\b/g, "idorclass"],
  [/\b(server side request forgery|ssrf)\b/g, "ssrfclass"],
  [/\b(json web token|jwt)\b/g, "jwtclass"],
  [/\b(cross site request forgery|csrf|xsrf)\b/g, "csrfclass"],
  [/\b(server side template injection|ssti)\b/g, "ssticlass"],
  [/\b(open redirect|unvalidated redirect)\b/g, "openredirectclass"],
  [/\b(xml external entity|xxe)\b/g, "xxeclass"],
  [/\b(command injection|os command injection|shell injection|cmdi)\b/g, "cmdclass"],
  [/\b(mass assignment|over posting)\b/g, "massassignclass"],
];

/**
 * Title key for the write-layer duplicate guard: case/punctuation/whitespace
 * normalised AND class synonyms folded, so a re-worded re-find updates the
 * existing row instead of creating a second one for the same issue (the
 * checklist's "one issue = one finding"). Pure.
 */
export function dupTitleKey(title: string): string {
  let t = (title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const [re, canonical] of CLASS_SYNONYMS) t = t.replace(re, canonical);
  // Drop the connectives a reworded duplicate changes freely ("at" vs "on",
  // "the" vs nothing). Without this the audit's own case — "SQL injection at
  // /api/user" vs "SQLi on /api/user" — still produced two different keys.
  return t
    .replace(/\b(at|on|in|of|for|from|to|via|the|a|an|is|are|ke|di|pada|dari|ke)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A browser-execution proof the finding already cites. Pure. */
const BROWSER_PROOF_RE =
  /dom_xss_prove|xss_hunt|PROVEN[^\n]{0,40}handler|handler (?:fired|ran|executed)|onerror\s*=|alert\s*\(|document\.cookie|window\.(?:location|name)\s*=|innerHTML\s*=\s*(?:["'`]|mia)|miaxdyn|__miaXssDyn/i;

/**
 * XSS needs EXECUTION proof, not a payload in a parameter (bounty-audit §2.1).
 *
 * This is an ADVISORY, not a refusal, and deliberately so: `findingGate` does
 * not gate CWE-79 because `poc_verify` (a server-side fetch) can never execute
 * script — gating it would block work that a browser prover has already proven,
 * and would teach the model to work around the gate. What a stored-XSS claim
 * without execution evidence actually is: a payload reflection, which is not
 * the finding. So we name the missing proof instead of refusing the write.
 */
export function xssProofAdvisory(f: ClassFacts & { evidence?: string; steps?: string }): string {
  if (vulnClass(f) !== "xss") return "";
  const text = `${f.evidence || ""}\n${f.steps || ""}`;
  if (BROWSER_PROOF_RE.test(text)) return "";
  return (
    "⚠️ XSS tanpa bukti EKSEKUSI: yang tercatat baru payload/refleksi di respons — itu belum XSS. " +
    "Buktikan di browser (dom_xss_prove untuk DOM, atau manual: payload stored → handler benar-benar jalan di origin aplikasi) " +
    "dan sebutkan hasil eksekusinya di evidence. Selama belum, tulis dampaknya sebagai risiko, bukan sebagai XSS terkonfirmasi."
  );
}
