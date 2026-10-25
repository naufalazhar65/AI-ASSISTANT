/**
 * PHP2Shell vulnerability assessment (CVE-2026-109618 / CVE-2026-109619).
 *
 * Non-invasive, read-only assessment: identifies PHP exposure, checks version
 * indicators, compares against patched versions, and classifies findings.
 * Never sends exploit payloads or modifies the target.
 *
 * Patched versions (PHP security release 2026-10-21):
 *   8.2 → 8.2.35, 8.3 → 8.3.36, 8.4 → 8.4.27, 8.5 → 8.5.12
 */

export interface Php2ShellResult {
  target: string;
  phpDetected: boolean;
  phpVersion: string | null;
  phpBranch: string | null;
  indicators: string[];
  classification: "CONFIRMED_PATCHED" | "LIKELY_AFFECTED" | "POTENTIALLY_EXPOSED" | "INCONCLUSIVE" | "NOT_APPLICABLE";
  confidence: "high" | "medium" | "low";
  evidence: string[];
  remediation: string[];
  limitations: string[];
}

const PATCHED_VERSIONS: Record<string, string> = {
  "8.2": "8.2.35",
  "8.3": "8.3.36",
  "8.4": "8.4.27",
  "8.5": "8.5.12",
};

const SUPPORTED_BRANCHES = ["8.2", "8.3", "8.4", "8.5"];

const PHP_PROBE_PATHS = [
  "/index.php",
  "/info.php",
  "/phpinfo.php",
  "/test.php",
  "/php.ini",
  "/.env",
  "/composer.json",
  "/composer.lock",
  "/vendor/autoload.php",
];

const PHP_BODY_MARKERS = [
  /phpinfo\(\)/i,
  /PHP Version\s*\d+\.\d+/i,
  /X-Powered-By.*PHP/i,
  /<title>phpinfo\(\)<\/title>/i,
  /Configuration File.*php\.ini/i,
  /Loaded Configuration File/i,
];

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

function detectPhpVersion(headers: Record<string, string>, body: string): string | null {
  // 1. X-Powered-By header
  const poweredBy = headers["x-powered-by"] || "";
  const phpMatch = poweredBy.match(/PHP\/(\d+\.\d+\.\d+)/i);
  if (phpMatch) return phpMatch[1];

  // 2. Server header
  const server = headers["server"] || "";
  const serverPhp = server.match(/PHP\/(\d+\.\d+\.\d+)/i);
  if (serverPhp) return serverPhp[1];

  // 3. Body: "PHP Version 8.x.x"
  const bodyPhp = body.match(/PHP Version\s*(\d+\.\d+\.\d+)/i);
  if (bodyPhp) return bodyPhp[1];

  // 4. Body: php-8.x.x
  const bodyPhp2 = body.match(/php-(\d+\.\d+\.\d+)/i);
  if (bodyPhp2) return bodyPhp2[1];

  // 5. Body: "PHP/8.x.x"
  const bodyPhp3 = body.match(/PHP\/(\d+\.\d+\.\d+)/i);
  if (bodyPhp3) return bodyPhp3[1];

  return null;
}

function detectPhpIndicators(headers: Record<string, string>, body: string, paths: { path: string; status: number; body: string }[]): string[] {
  const indicators: string[] = [];

  const poweredBy = headers["x-powered-by"] || "";
  if (/PHP/i.test(poweredBy)) indicators.push(`X-Powered-By: ${poweredBy}`);

  const server = headers["server"] || "";
  if (/PHP/i.test(server)) indicators.push(`Server: ${server}`);

  for (const marker of PHP_BODY_MARKERS) {
    if (marker.test(body)) {
      indicators.push(`Body marker: ${marker.source}`);
    }
  }

  for (const p of paths) {
    if (p.status === 200) {
      if (p.path.endsWith(".php")) indicators.push(`PHP file accessible: ${p.path}`);
      if (p.path === "/composer.json") indicators.push("composer.json accessible (PHP project metadata)");
      if (p.path === "/composer.lock") indicators.push("composer.lock accessible (PHP dependency lock)");
      if (p.path === "/.env") indicators.push(".env accessible (potential secret exposure)");
      if (p.path === "/vendor/autoload.php") indicators.push("vendor/autoload.php accessible (Composer autoloader)");
      if (p.path === "/php.ini") indicators.push("php.ini accessible (PHP configuration exposed)");
    }
  }

  return indicators;
}

export async function php2shellAssess(target: string): Promise<Php2ShellResult> {
  const url = target.trim().replace(/\/+$/, "");
  const evidence: string[] = [];
  const limitations: string[] = [];
  const remediation: string[] = [];

  // Phase 1: Passive HTTP reconnaissance
  const headers: Record<string, string> = {};
  let body = "";
  let status = 0;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "Mia-PHP2Shell-Assessment/1.0" },
    });
    clearTimeout(timer);
    status = res.status;
    for (const [k, v] of res.headers.entries()) {
      headers[k.toLowerCase()] = v;
    }
    body = await res.text();
    evidence.push(`HTTP GET ${url} → ${status} (${body.length} bytes)`);
    evidence.push(`Server: ${headers["server"] || "(none)"}`);
    evidence.push(`X-Powered-By: ${headers["x-powered-by"] || "(none)"}`);
    evidence.push(`Content-Type: ${headers["content-type"] || "(none)"}`);
  } catch (e) {
    limitations.push(`HTTP request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Phase 1b: Probe common PHP paths
  const pathResults: { path: string; status: number; body: string }[] = [];
  for (const p of PHP_PROBE_PATHS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${url}${p}`, {
        method: "GET",
        signal: controller.signal,
        headers: { "User-Agent": "Mia-PHP2Shell-Assessment/1.0" },
        redirect: "manual",
      });
      clearTimeout(timer);
      const b = await res.text();
      pathResults.push({ path: p, status: res.status, body: b });
      if (res.status === 200) {
        evidence.push(`GET ${p} → 200 (${b.length} bytes)`);
      }
    } catch (e) {
      pathResults.push({ path: p, status: 0, body: "" });
    }
  }

  // Phase 2: Detect PHP indicators
  const indicators = detectPhpIndicators(headers, body, pathResults);
  const phpVersion = detectPhpVersion(headers, body);

  if (phpVersion) {
    evidence.push(`PHP version detected: ${phpVersion}`);
  }

  const phpDetected = indicators.length > 0 || phpVersion !== null;

  // Phase 5: Classify findings
  let classification: Php2ShellResult["classification"];
  let confidence: Php2ShellResult["confidence"];

  if (!phpDetected) {
    classification = "NOT_APPLICABLE";
    confidence = "high";
    evidence.push("No PHP indicators found in HTTP headers, response body, or common PHP paths.");
    remediation.push("Target does not appear to use PHP. CVE-2026-109618/109619 are not applicable.");
    limitations.push("Assessment was passive (HTTP GET only). If PHP is used internally (e.g., behind a reverse proxy or in a different service), it may not be visible from the public endpoint.");
  } else if (phpVersion) {
    const branch = phpVersion.split(".").slice(0, 2).join(".");
    const patched = PATCHED_VERSIONS[branch];
    if (patched && compareVersions(phpVersion, patched) >= 0) {
      classification = "CONFIRMED_PATCHED";
      confidence = "high";
      evidence.push(`PHP ${phpVersion} >= patched version ${patched} for branch ${branch}`);
      remediation.push("No action needed for PHP2Shell. Continue monitoring for new advisories.");
    } else if (patched) {
      classification = "LIKELY_AFFECTED";
      confidence = "medium";
      evidence.push(`PHP ${phpVersion} < patched version ${patched} for branch ${branch}`);
      remediation.push(`Upgrade PHP to ${patched} or later (branch ${branch}).`);
      remediation.push("Verify the runtime actually used by the application matches the patched version.");
      remediation.push("Check for backported patches from the OS vendor.");
    } else {
      classification = "POTENTIALLY_EXPOSED";
      confidence = "low";
      evidence.push(`PHP ${phpVersion} — branch ${branch} not in known patched versions (may be unsupported or too new)`);
      remediation.push("Verify PHP branch support status. Unsupported branches should be migrated.");
    }
  } else {
    classification = "POTENTIALLY_EXPOSED";
    confidence = "low";
    evidence.push("PHP indicators found but version could not be determined.");
    remediation.push("Determine the exact PHP version and compare against patched versions.");
    remediation.push("Check server configuration, package metadata, or container image for version info.");
    limitations.push("Version not identifiable from passive HTTP inspection. May require SSH/container access.");
  }

  // Branch support check
  if (phpVersion) {
    const branch = phpVersion.split(".").slice(0, 2).join(".");
    if (!SUPPORTED_BRANCHES.includes(branch)) {
      limitations.push(`PHP branch ${branch} may be end-of-life. Unsupported branches do not receive security patches.`);
      remediation.push(`Migrate to a supported PHP branch (8.2, 8.3, 8.4, or 8.5).`);
    }
  }

  // Exposed PHP files remediation
  const exposedPaths = pathResults.filter((p) => p.status === 200 && (p.path.endsWith(".php") || p.path === "/.env" || p.path === "/composer.json" || p.path === "/vendor/autoload.php" || p.path === "/php.ini"));
  if (exposedPaths.length > 0) {
    remediation.push("Remove or restrict access to exposed PHP files and metadata (.env, composer.json, php.ini, vendor/autoload.php).");
    remediation.push("Ensure web server denies direct access to sensitive files.");
  }

  if (limitations.length === 0) {
    limitations.push("Assessment was passive (HTTP GET only). Runtime version may differ from reported version.");
  }

  return {
    target: url,
    phpDetected,
    phpVersion,
    phpBranch: phpVersion ? phpVersion.split(".").slice(0, 2).join(".") : null,
    indicators,
    classification,
    confidence,
    evidence,
    remediation,
    limitations,
  };
}

export function formatPhp2ShellResult(r: Php2ShellResult): string {
  const lines: string[] = [];
  lines.push(`=== PHP2Shell Assessment (CVE-2026-109618 / CVE-2026-109619) ===`);
  lines.push(`Target: ${r.target}`);
  lines.push(`PHP detected: ${r.phpDetected ? "YES" : "NO"}`);
  if (r.phpVersion) lines.push(`PHP version: ${r.phpVersion}`);
  if (r.phpBranch) lines.push(`PHP branch: ${r.phpBranch}`);
  lines.push(`Classification: ${r.classification} (confidence: ${r.confidence})`);
  lines.push("");

  if (r.indicators.length > 0) {
    lines.push("Indicators:");
    for (const i of r.indicators) lines.push(`  - ${i}`);
    lines.push("");
  }

  lines.push("Evidence:");
  for (const e of r.evidence) lines.push(`  - ${e}`);
  lines.push("");

  lines.push("Remediation:");
  for (const r2 of r.remediation) lines.push(`  - ${r2}`);
  lines.push("");

  lines.push("Limitations:");
  for (const l of r.limitations) lines.push(`  - ${l}`);

  return lines.join("\n");
}