// Lightweight observability (Fase 5): in-process counters for turns, tool
// calls, errors, and average latency — exposed via `getTurnStats()`. Fed by
// `runAssistantTurn` (wrapper) and `executeTool`. No external dependency; a
// restart resets counters (acceptable for single-process personal deploy).

interface TurnStatEntry {
  user: string;
  ts: number;
  latencyMs: number;
  ok: boolean;
  kind?: string;
}

const stats = {
  startedAt: Date.now(),
  turns: 0,
  turnsOk: 0,
  turnsFailed: 0,
  toolCalls: 0,
  totalLatencyMs: 0,
  errorKinds: new Map<string, number>(),
  recent: [] as TurnStatEntry[],
};

const RECENT_CAP = 50;

export interface TurnStats {
  uptimeSeconds: number;
  turns: number;
  turnsOk: number;
  turnsFailed: number;
  errorRatePct: number;
  toolCalls: number;
  avgLatencyMs: number;
  lastTurnMs: number;
  topErrors: { kind: string; count: number }[];
  recent: TurnStatEntry[];
}

export function recordTurn(user: unknown, latencyMs: number, ok: boolean, kind?: string): void {
  stats.turns += 1;
  ok ? (stats.turnsOk += 1) : (stats.turnsFailed += 1);
  stats.totalLatencyMs += latencyMs;
  if (kind) stats.errorKinds.set(kind, (stats.errorKinds.get(kind) ?? 0) + 1);
  const entry: TurnStatEntry = {
    user: String(user ?? "anonymous").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 20) || "anonymous",
    ts: Date.now(),
    latencyMs,
    ok,
    ...(kind ? { kind } : {}),
  };
  stats.recent.push(entry);
  if (stats.recent.length > RECENT_CAP) stats.recent.shift();
}

export function recordToolCall(user: unknown, name: string): void {
  void user;
  void name;
  stats.toolCalls += 1;
}

export function getTurnStats(): TurnStats {
  const errors = [...stats.errorKinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
  return {
    uptimeSeconds: Math.round((Date.now() - stats.startedAt) / 1000),
    turns: stats.turns,
    turnsOk: stats.turnsOk,
    turnsFailed: stats.turnsFailed,
    errorRatePct: stats.turns ? Math.round((stats.turnsFailed / stats.turns) * 100) : 0,
    toolCalls: stats.toolCalls,
    avgLatencyMs: stats.turns ? Math.round(stats.totalLatencyMs / stats.turns) : 0,
    lastTurnMs: stats.recent.length ? stats.recent[stats.recent.length - 1].latencyMs : 0,
    topErrors: errors,
    recent: [...stats.recent],
  };
}