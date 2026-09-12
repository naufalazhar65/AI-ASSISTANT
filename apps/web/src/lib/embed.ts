import { cfgStr } from "./config";

export class EmbeddingError extends Error {}

const BATCH = 32;

/**
 * Fail-fast circuit breaker: once the embedding endpoint errors, skip all
 * embedding attempts for a short TTL so every-turn recall degrades straight to
 * BM25 instead of paying a timeout on each call. Reset so a newly configured
 * endpoint is picked up after the window elapses.
 */
let embedDeadUntilMs = 0;
export function embeddingAvailable(): boolean {
  return Date.now() >= embedDeadUntilMs;
}
export function markEmbeddingUnavailable(): void {
  embedDeadUntilMs = Date.now() + 60_000;
}

export function embedEndpoint(): string {
  const override = cfgStr("EMBED_API_BASE", "");
  if (override) return override.replace(/\/+$/, "") + "/embeddings";
  const llm = cfgStr("LLM_API_BASE", "");
  const stripped = llm.replace(/\/chat\/completions$/, "").replace(/\/+$/, "");
  if (!stripped) throw new EmbeddingError("no embedding endpoint configured (EMBED_API_BASE or LLM_API_BASE)");
  return stripped + "/embeddings";
}

export function embedModel(): string {
  return cfgStr("EMBED_MODEL", "gemini/gemini-embedding-001");
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!embeddingAvailable()) throw new EmbeddingError("embedding endpoint previously failed (circuit open for 60s)");
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const apiKey = cfgStr("LLM_API_KEY", "");
    try {
      const res = await fetch(embedEndpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: embedModel(), input: batch }),
        // Fast-fail when the embedding endpoint is unavailable/slow (e.g. a
        // proxy with no real embed backend): a 11s connect timeout would stall
        // every turn's memory recall. Callers fall back to BM25 on failure.
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new EmbeddingError(`embed ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: { embedding?: number[] }[] };
      if (!Array.isArray(json.data)) throw new EmbeddingError("embed: malformed response");
      for (const d of json.data) {
        if (!Array.isArray(d.embedding)) throw new EmbeddingError("embed: missing vector");
        out.push(d.embedding);
      }
    } catch (err) {
      // Any failure — HTTP error, malformed body, network/timeout — opens the
      // breaker so subsequent turns within the window skip straight to BM25
      // instead of re-paying a multi-second timeout per call.
      markEmbeddingUnavailable();
      throw err;
    }
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}