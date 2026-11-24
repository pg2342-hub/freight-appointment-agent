// Cloudflare Worker: the web inbox API, the eval endpoint golive-gate calls, and trace pages.
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import seedWorld from "../seed/world.json";
import { runAgent } from "./agent";
import { D1Store } from "./d1store";
import { calendarFor } from "./calendar";
import { proposalFrom, runCase, threadText, type CaseInput } from "./eval";
import { ClaudeModel, ScriptedModel, type Model } from "./model";
import { tracePage } from "./trace";
import type { FacilityBehavior } from "./store";
import type { World } from "./world";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VERSION: string; // which agent version this deploy is, e.g. v1
  MODEL_MODE: "claude" | "scripted" | "scripted-naive";
  DAILY_BUDGET_USD: string;
  ANTHROPIC_API_KEY?: string;
  EVAL_TOKEN?: string;
}

const WORLD = seedWorld as unknown as World;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/eval") return await handleEval(req, env);
      if (req.method === "POST" && url.pathname === "/api/message") return await handleMessage(req, env);
      if (req.method === "GET" && url.pathname.startsWith("/trace/")) {
        return await tracePage(env.DB, decodeURIComponent(url.pathname.slice("/trace/".length)));
      }
      if (req.method === "GET" && url.pathname === "/api/health") return json({ ok: true, version: env.VERSION, model: env.MODEL_MODE });
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },
};

/** golive-gate posts {"input": case input}; answer {"output": proposal, "cost_usd": n}. */
async function handleEval(req: Request, env: Env) {
  if (!env.EVAL_TOKEN || req.headers.get("authorization") !== `Bearer ${env.EVAL_TOKEN}`) return json({ error: "unauthorized" }, 401);
  const { input } = (await req.json()) as { input: CaseInput };
  const makeModel = (w: World, b: FacilityBehavior): Model =>
    env.MODEL_MODE.startsWith("scripted") ? new ScriptedModel(input.facts as never, b, w, env.MODEL_MODE === "scripted-naive") : new ClaudeModel(requireKey(env));
  const { output, cost_usd } = await runCase(input, WORLD, makeModel);
  if (cost_usd > 0) await addSpend(env.DB, cost_usd);
  return json({ output, cost_usd, version: env.VERSION });
}

async function handleMessage(req: Request, env: Env) {
  if (env.MODEL_MODE !== "claude" || !env.ANTHROPIC_API_KEY) return json({ error: "The live model is not configured on this deploy." }, 503);
  const body = (await req.json()) as { conversation_id?: string; from?: string; message?: string };
  const text = (body.message ?? "").trim().slice(0, 4000);
  if (!text) return json({ error: "empty message" }, 400);
  if ((await spentToday(env.DB)) >= Number(env.DAILY_BUDGET_USD || "5"))
    return json({ error: "The demo has used today's budget. Please try again tomorrow." }, 429);

  const now = new Date().toISOString();
  let id = body.conversation_id;
  let history: BetaMessageParam[] = [];
  let sender = (body.from ?? "").trim().slice(0, 120) || "unknown sender";
  if (id) {
    const row = await env.DB.prepare("SELECT messages, sender FROM conversations WHERE id = ?").bind(id).first<{ messages: string; sender: string }>();
    if (!row) return json({ error: "unknown conversation" }, 404);
    history = JSON.parse(row.messages);
    sender = row.sender;
  } else {
    id = crypto.randomUUID();
  }
  if (history.length > 40) return json({ error: "This conversation is too long. Please start a new one." }, 400);
  const userText = history.length
    ? `--- Reply from ${sender}\n\n${text}`
    : threadText([{ from: sender, body: text }], new Date().toISOString().slice(0, 16) + "Z");
  history.push({ role: "user", content: userText });

  const t0 = Date.now();
  const store = new D1Store(env.DB, id);
  const before = structuredClone(await store.world());
  const result = await runAgent(new ClaudeModel(requireKey(env)), store, history);
  await store.commit();
  const ms = Date.now() - t0;
  const turn = history.filter((m) => m.role === "user" && typeof m.content === "string").length;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO conversations (id, created_at, updated_at, sender, version, messages, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, messages = excluded.messages, cost_usd = cost_usd + ?`,
    ).bind(id, now, now, sender, env.VERSION, JSON.stringify(result.messages), result.cost_usd, result.cost_usd),
    env.DB.prepare(
      "INSERT INTO turns (conversation_id, turn, created_at, version, user_text, reply, stopped, steps, cost_usd, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, turn, now, env.VERSION, text, result.reply, result.stopped, JSON.stringify(result.steps), result.cost_usd, ms),
  ]);
  await addSpend(env.DB, result.cost_usd);
  const steps = result.steps.filter((s) => s.kind === "tool").map((s: any) => ({ name: s.name, ok: s.ok, status: s.output?.status ?? null, error: s.error ?? null }));
  return json({
    conversation_id: id,
    reply: result.reply,
    result: proposalFrom(result.steps, result.reply, result.stopped),
    calendar: calendarFor(await store.world(), result.steps, before),
    steps,
    trace_url: `/trace/${id}`,
    version: env.VERSION,
  });
}

function requireKey(env: Env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  return env.ANTHROPIC_API_KEY;
}

const today = () => new Date().toISOString().slice(0, 10);

async function spentToday(db: D1Database) {
  const row = await db.prepare("SELECT usd FROM spend WHERE day = ?").bind(today()).first<{ usd: number }>();
  return row?.usd ?? 0;
}

async function addSpend(db: D1Database, usd: number) {
  await db.prepare("INSERT INTO spend (day, usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd").bind(today(), usd).run();
}
