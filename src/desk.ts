// Read-only endpoints behind the desk console (/desk/).
// /api/desk/live: counts over the last 7 days of live threads. Numbers only, never email text or senders.
// /api/desk/thread/<id>: one live thread for whoever holds its id (the same id the email reply's trace link carries).
import type { TraceStep } from "./agent";

type ToolStep = Extract<TraceStep, { kind: "tool" }>;
type TurnRow = { conversation_id: string; created_at: string; stopped: string; steps: string; cost_usd: number; ms: number; version: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const DAYS = 7;

export async function deskLive(db: D1Database, version: string, budgetUsd: number): Promise<Response> {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { results } = await db
    .prepare("SELECT conversation_id, created_at, stopped, steps, cost_usd, ms, version FROM turns WHERE created_at >= ? ORDER BY created_at DESC LIMIT 1000")
    .bind(since)
    .all<TurnRow>();

  const byDay = new Map<string, { threads: Set<string>; turns: number }>();
  for (let i = DAYS - 1; i >= 0; i--) byDay.set(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), { threads: new Set(), turns: 0 });
  const tools = new Map<string, { calls: number; errors: number }>();
  const handoffs = new Map<string, number>();
  const threads = new Set<string>();
  let booked = 0, recorded = 0, handedOff = 0, cost = 0, ms = 0;

  for (const t of results) {
    threads.add(t.conversation_id);
    cost += t.cost_usd;
    ms += t.ms;
    const day = byDay.get(t.created_at.slice(0, 10));
    if (day) { day.turns++; day.threads.add(t.conversation_id); }
    let steps: TraceStep[] = [];
    try { steps = JSON.parse(t.steps); } catch { /* a malformed row counts as no tool calls */ }
    for (const s of steps.filter((x): x is ToolStep => x.kind === "tool")) {
      const e = tools.get(s.name) ?? { calls: 0, errors: 0 };
      e.calls++;
      if (!s.ok) e.errors++;
      tools.set(s.name, e);
      const out = s.output as { status?: string } | null;
      if (s.ok && s.name === "request_appointment" && out?.status === "confirmed") booked++;
      if (s.ok && (s.name === "record_existing_appointment" || s.name === "record_fcfs")) recorded++;
      if (s.ok && s.name === "hand_off") {
        handedOff++;
        const reason = String((s.input as { reason?: string })?.reason ?? "unknown");
        handoffs.set(reason, (handoffs.get(reason) ?? 0) + 1);
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const spend = await db.prepare("SELECT usd FROM spend WHERE day = ?").bind("live:" + today).first<{ usd: number }>();
  return json({
    since,
    days: DAYS,
    version,
    threads: threads.size,
    turns: results.length,
    booked,
    recorded,
    handed_off: handedOff,
    cost_usd: cost,
    mean_ms: results.length ? Math.round(ms / results.length) : null,
    spend_today_usd: spend?.usd ?? 0,
    budget_usd: budgetUsd,
    by_day: [...byDay].map(([date, d]) => ({ date, threads: d.threads.size, turns: d.turns })),
    tools: [...tools].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.calls - a.calls),
    handoffs: [...handoffs].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
  });
}

export async function deskThread(db: D1Database, id: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "not found" }, 404);
  const conv = await db.prepare("SELECT id, created_at, updated_at, sender, version, cost_usd FROM conversations WHERE id = ?").bind(id).first();
  if (!conv) return json({ error: "not found" }, 404);
  const { results } = await db
    .prepare("SELECT turn, created_at, version, user_text, reply, stopped, steps, cost_usd, ms FROM turns WHERE conversation_id = ? ORDER BY turn")
    .bind(id)
    .all<{ steps: string } & Record<string, unknown>>();
  return json({ ...conv, turns: results.map((t) => ({ ...t, steps: JSON.parse(t.steps) })) });
}
