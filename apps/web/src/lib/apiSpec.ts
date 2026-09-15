// API surface tooling — enumerate endpoints from an OpenAPI/Swagger or Postman
// spec (JSON), and introspect a GraphQL endpoint. Spec files load from the
// sandbox; spec/GraphQL URLs are scope-gated (lab/engagement/PENTEST_LAB_TARGETS).
import { existsSync, readFileSync } from "node:fs";
import { resolveInSandbox } from "./users";
import { targetAllowed } from "./security";
import { assertPublicUrl } from "./netGuard";

export type ApiEndpoint = { method: string; path: string; params: string[] };

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

/** OpenAPI/Swagger JSON → endpoints (method, path, parameter names). */
export function parseOpenApi(spec: unknown): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> })?.paths;
  if (!paths || typeof paths !== "object") return out;
  for (const [p, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== "object") continue;
    const shared = ((ops as { parameters?: unknown[] }).parameters || []) as { name?: string }[];
    for (const m of METHODS) {
      if (!(ops as Record<string, unknown>)[m]) continue;
      const own = (((ops as Record<string, Record<string, unknown>>)[m] as { parameters?: unknown[] }).parameters || []) as { name?: string }[];
      const params = [...shared, ...own].map((x) => x?.name).filter((x): x is string => !!x);
      out.push({ method: m.toUpperCase(), path: p, params: [...new Set(params)] });
    }
  }
  return out;
}

/** Postman collection JSON → endpoints (method, raw url). */
export function parsePostman(col: unknown): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  const walk = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const it of items as { item?: unknown; request?: { method?: string; url?: unknown } }[]) {
      if (it?.item) walk(it.item);
      else if (it?.request) {
        const r = it.request;
        const url = typeof r.url === "string" ? r.url : ((r.url as { raw?: string })?.raw || "");
        out.push({ method: (r.method || "GET").toUpperCase(), path: url, params: [] });
      }
    }
  };
  walk((col as { item?: unknown })?.item);
  return out;
}

async function loadSpec(opts: { path?: string; url?: string; text?: string }): Promise<{ raw: string; source: string } | { error: string }> {
  if (opts.path) {
    const p = resolveInSandbox(opts.path.trim());
    if (!p || !existsSync(p)) return { error: `file spec tidak ditemukan di sandbox: ${opts.path}` };
    return { raw: readFileSync(p, "utf8"), source: opts.path };
  }
  if (opts.text) return { raw: opts.text, source: "teks" };
  if (opts.url) {
    const u = opts.url.trim();
    if (!/^https?:\/\//i.test(u)) return { error: "URL spec harus http(s)." };
    let target: string;
    if (targetAllowed(u)) target = u;
    else {
      try {
        target = assertPublicUrl(u).toString();
      } catch (e) {
        return { error: `SCOPE: ${e instanceof Error ? e.message : "URL tidak diizinkan"}` };
      }
    }
    try {
      const res = await fetch(target, { headers: { "User-Agent": "mia-assistant/1.0" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { error: `gagal ambil spec (HTTP ${res.status}).` };
      return { raw: await res.text(), source: u };
    } catch (e) {
      return { error: `gagal ambil spec: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { error: "beri `path` (file sandbox), `url`, atau `text` (spec JSON)." };
}

export async function apiSpec(opts: { path?: string; url?: string; text?: string }): Promise<string> {
  const loaded = await loadSpec(opts);
  if ("error" in loaded) return `Error: ${loaded.error}`;
  let json: unknown;
  try {
    json = JSON.parse(loaded.raw);
  } catch {
    return "Error: spec bukan JSON valid. (Versi YAML belum didukung — konversi ke JSON atau pakai endpoint /openapi.json.)";
  }
  const j = json as { openapi?: string; swagger?: string; info?: { schema?: string }; item?: unknown };
  let endpoints: ApiEndpoint[] = [];
  let kind = "OpenAPI/Swagger";
  if (j.openapi || j.swagger) endpoints = parseOpenApi(json);
  else if (j.item || /postman/i.test(j.info?.schema || "")) {
    endpoints = parsePostman(json);
    kind = "Postman";
  } else endpoints = parseOpenApi(json);
  if (!endpoints.length) return `Spec ${kind} (${loaded.source}) terbaca tapi tidak ada endpoint.`;
  const shown = endpoints.slice(0, 120);
  return [
    `🔌 API SPEC ${kind} (${loaded.source}) — ${endpoints.length} endpoint${endpoints.length > shown.length ? ` (tampil ${shown.length})` : ""}:`,
    ...shown.map((e) => `• ${e.method} ${e.path}${e.params.length ? `  [${e.params.join(", ")}]` : ""}`),
    "",
    "Lanjut: uji tiap endpoint ber-parameter via http_request (authed) / bola_diff / param_fuzz → finding_add.",
  ].join("\n");
}

const INTROSPECTION = "query IntrospectionQuery{__schema{queryType{name fields{name args{name}}} mutationType{name fields{name}}}}";

export async function graphqlProbe(urlRaw: string): Promise<string> {
  const u = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Error: URL harus http(s).";
  if (!targetAllowed(u)) return "Error: SCOPE — graphql_probe hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let res: Response;
  try {
    res = await fetch(u, {
      method: "POST",
      headers: { "content-type": "application/json", "User-Agent": "mia-assistant/1.0" },
      body: JSON.stringify({ query: INTROSPECTION, operationName: "IntrospectionQuery" }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return `Error: request gagal (${e instanceof Error ? e.message : String(e)}).`;
  }
  const text = (await res.text()).slice(0, 100_000);
  let j: { data?: { __schema?: { queryType?: { name?: string; fields?: { name?: string }[] }; mutationType?: { name?: string; fields?: { name?: string }[] } } }; errors?: { message?: string }[] };
  try {
    j = JSON.parse(text);
  } catch {
    return `GraphQL ${u} → HTTP ${res.status} (bukan JSON — mungkin bukan endpoint GraphQL).`;
  }
  if (j.errors?.length && !j.data?.__schema) {
    return `GraphQL ${u} → ${res.status}. Introspection DILARANG/err: ${j.errors.map((e) => e.message).slice(0, 2).join("; ")}\n(Coba field-guessing / kirim query manual via http_request; playbook security_playbook name=graphql.)`;
  }
  const q = j.data?.__schema?.queryType?.fields?.map((f) => f.name) || [];
  const m = j.data?.__schema?.mutationType?.fields?.map((f) => f.name) || [];
  return [
    `🔺 GraphQL introspection ${u} → HTTP ${res.status}`,
    q.length ? `Query (${q.length}): ${q.slice(0, 60).join(", ")}` : "Query: (kosong)",
    m.length ? `Mutation (${m.length}): ${m.slice(0, 40).join(", ")}` : "Mutation: -",
    "",
    "Lanjut: uji batching/aliasing, depth limit, dan otorisasi per-field (lihat playbook `graphql`).",
  ].join("\n");
}
