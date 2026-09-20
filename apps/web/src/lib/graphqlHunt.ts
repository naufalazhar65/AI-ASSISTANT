// graphql_hunt — deep GraphQL security probe for authorized targets.
// Upgrades graphql_probe (introspection only) with: field-suggestion mining when
// introspection is blocked, alias/batching abuse checks, GET-query support, and a
// depth/complexity limit probe. Bounded requests, scope-gated.
import { targetAllowed, politeDelay } from "./security";
import { sessionHeaders } from "./httpSession";
import { recordHttp } from "./httpHistory";

const UA = "mia-assistant/1.0";

const INTROSPECTION = "query IntrospectionQuery{__schema{queryType{name fields{name args{name}}} mutationType{name fields{name}}}}";

type GqlRes = { status: number; body: string; json?: unknown };

async function gql(url: string, body: string, session?: string, rawUser?: unknown, method = "POST"): Promise<GqlRes> {
  const headers: Record<string, string> = { "User-Agent": UA, "content-type": "application/json" };
  if (session && rawUser) {
    const s = sessionHeaders(rawUser, session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie) headers["cookie"] = s.cookie;
    }
  }
  try {
    const res = await fetch(method === "GET" ? `${url}${url.includes("?") ? "&" : "?"}query=${encodeURIComponent(body)}` : url, {
      method, headers, body: method === "GET" ? undefined : body, redirect: "manual", signal: AbortSignal.timeout(12_000),
    });
    const text = (await res.text()).slice(0, 100_000);
    let json: unknown;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    recordHttp(rawUser, { method, url, status: res.status, bytes: text.length, ms: 0, at: new Date().toISOString() });
    return { status: res.status, body: text, json };
  } catch (e) {
    return { status: 0, body: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Extract `Did you mean "x" or "y"?` suggestions from GraphQL error output. Pure. */
export function parseSuggestions(text: string): string[] {
  const out: string[] = [];
  const re = /Did you mean ([^?]+)\?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const names = m[1].match(/[`"']([A-Za-z_][A-Za-z0-9_]*)[`"']/g) || [];
    for (const raw of names) {
      const n = raw.slice(1, -1);
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** Parse top-level query/mutation field names from a shallow introspection reply. Pure. */
export function parseGraphqlFields(json: unknown): { query: string[]; mutation: string[] } {
  const schema = (json as { data?: { __schema?: { queryType?: { fields?: { name?: string }[] }; mutationType?: { fields?: { name?: string }[] } } } })?.data?.__schema;
  return {
    query: [...new Set((schema?.queryType?.fields || []).map((f) => f.name || "").filter(Boolean))],
    mutation: [...new Set((schema?.mutationType?.fields || []).map((f) => f.name || "").filter(Boolean))],
  };
}

/** Classify the JSON-array batching probe. Pure. */
export function batchVerdict(json: unknown): "batched" | "single" | "rejected" {
  if (Array.isArray(json)) return "batched";
  const o = json as { errors?: unknown[]; data?: unknown } | null;
  if (o && typeof o === "object" && (o.data !== undefined || (Array.isArray(o.errors) && o.errors.length === 0))) return "single";
  if (o && Array.isArray(o.errors) && o.errors.length) return "rejected";
  return "rejected";
}

/** Build a deeply nested query from a root field (depth probe payload). Pure. */
export function depthProbeQuery(field: string, depth: number): string {
  let q = field;
  for (let i = 0; i < depth; i++) q = `${q}{${field}`;
  q += "}".repeat(depth);
  return `query DepthProbe{${q}}`;
}

/** SUGGESTION_PROBES: bogus-ish names sent to mine `Did you mean` hints. */
export const SUGGESTION_PROBES = ["zzzmia", "users", "me", "node", "login", "posts"];

export async function graphqlHunt(rawUser: unknown, opts: { url: string; session?: string; depth?: number }): Promise<string> {
  const u = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Error: URL harus http(s).";
  if (!targetAllowed(u)) return "Error: SCOPE — graphql_hunt hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  const lines: string[] = [];
  const depth = Math.min(100, Math.max(10, Number(opts.depth) || 50));

  // 1) Introspection
  const intro = await gql(u, JSON.stringify({ query: INTROSPECTION, operationName: "IntrospectionQuery" }), opts.session, rawUser);
  await politeDelay();
  let fields: { query: string[]; mutation: string[] } | null = null;
  if (intro.json && parseGraphqlFields(intro.json).query.length) {
    fields = parseGraphqlFields(intro.json);
    lines.push(`✅ Introspection TERBUKA → ${fields.query.length} query field, ${fields.mutation.length} mutation field.`);
    lines.push(`   Query: ${fields.query.slice(0, 40).join(", ")}${fields.query.length > 40 ? " …" : ""}`);
    if (fields.mutation.length) lines.push(`   Mutation: ${fields.mutation.slice(0, 25).join(", ")}${fields.mutation.length > 25 ? " …" : ""}`);
  } else {
    lines.push(`🔒 Introspection diblokir/error (${intro.status}) — lanjut field-suggestion mining.`);
    // 2) Field-suggestion mining
    const found = new Set<string>();
    for (const probe of SUGGESTION_PROBES) {
      const r = await gql(u, JSON.stringify({ query: `query MiaProbe{${probe}}` }), opts.session, rawUser);
      const s = parseSuggestions(r.body);
      s.forEach((x) => found.add(x));
      await politeDelay();
    }
    lines.push(found.size ? `🔎 Field ter-suggest (${found.size}): ${[...found].slice(0, 40).join(", ")}\n   → brute halus: kirim query per-field untuk cek akses tanpa auth.` : "   Tidak ada suggestion (error generik / placeholder).");
  }

  // 3) Batching abuse (JSON array body)
  const batch = await gql(u, JSON.stringify([{ query: "{__typename}" }, { query: "{__typename}" }]), opts.session, rawUser);
  await politeDelay();
  const bv = batchVerdict(batch.json);
  lines.push(bv === "batched"
    ? "⚠️ BATCHING AKTIF — endpoint menerima JSON-array query (query batching/alias bombing mungkin; cek rate-limit internal)."
    : "Batching: tidak aktif / ditolak.");

  // 4) Alias abuse
  const alias = await gql(u, JSON.stringify({ query: "query{a: __typename b: __typename}" }), opts.session, rawUser);
  await politeDelay();
  const aliasOk = !!(alias.json as { data?: Record<string, unknown> } | undefined)?.data?.a && !!(alias.json as { data?: Record<string, unknown> } | undefined)?.data?.b;
  lines.push(aliasOk ? "ℹ️ Alias ganda diterima (normal, tapi memperkuat vektor batching)." : "Alias ganda ditolak/error.");

  // 5) Depth / complexity probe
  const root = fields?.query[0] || "__typename";
  const dp = await gql(u, JSON.stringify({ query: depthProbeQuery(root === "__typename" ? "x" : root, depth) }), opts.session, rawUser);
  const db = dp.body;
  if (/depth|complexit|too deep|too many|nested/i.test(db)) lines.push(`✅ Depth/complexity limit AKTIF (error menyebut: ${db.match(/(depth|complexit)[a-z ]*/i)?.[0] || "limit"}).`);
  else if (/Cannot query field/i.test(db)) lines.push("Depth probe tidak konklusif (field root tidak valid) — ulangi dengan field asli dari introspection.");
  else if (dp.status === 200) lines.push("⚠️ Depth probe dijawab 200 — tidak ada limit kedalaman yang terlihat.");
  else lines.push(`Depth probe: status ${dp.status} (tidak konklusif).`);

  // 6) GET query support (CSWSH-style cache/key confusion + GET introspection)
  const get = await gql(u, "{__typename}", opts.session, rawUser, "GET");
  lines.push(get.status === 200 && get.json ? "ℹ️ Query via GET diterima (query bisa lewat GET — perhatikan caching per-URL)." : "GET query: ditolak.");

  const head = `🔺 GRAPHQL HUNT ${u}`;
  return `${head}\n${lines.join("\n")}\n\n⚠️ Batching/depth tanpa limit = KANDIDAT (uji dampak: alias bombing bounded, bukan DoS). Field tanpa auth → uji via bola_diff/auth_matrix → poc_verify → finding_add.`;
}
