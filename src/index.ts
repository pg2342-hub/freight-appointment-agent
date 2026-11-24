// Cloudflare Worker: the web inbox API, the eval endpoint golive-gate calls, and trace pages.
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import seedWorld from "../seed/world.json";
import { EmailMessage } from "cloudflare:email";
import PostalMime from "postal-mime";
import { runAgent, type AgentResult } from "./agent";
import { D1Store } from "./d1store";
import { calendarFor } from "./calendar";
import { proposalFrom, runCase, threadText, type CaseInput } from "./eval";
import { ClaudeModel, ScriptedModel, type Model } from "./model";
import { buildReply, newText, plainText, skipReason, threadKeys } from "./email";
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
  EMAIL_ADDRESS?: string; // appointments@pranavgudise.dev
  PUBLIC_URL?: string; // where trace links in email replies point
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
      if (req.method === "GET" && url.pathname === "/api/releases") return await releases(env);
      if (req.method === "GET" && url.pathname === "/api/health") return json({ ok: true, version: env.VERSION, model: env.MODEL_MODE });
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },
  async email(message: ForwardableEmailMessage, env: Env) {
    try {
      await handleEmail(message, env);
    } catch (e) {
      console.error("email failed", e);
      await env.DB.prepare("INSERT INTO events (thread_id, created_at, kind, data) VALUES ('email', datetime('now'), 'email_error', ?)")
        .bind(JSON.stringify({ from: message.from, error: String(e), stack: (e as Error)?.stack?.slice(0, 800) ?? null }))
        .run()
        .catch(() => {});
    }
  },
  async scheduled(_c: ScheduledController, env: Env) {
    await resetWorld(env);
  },
};

/** The staged rollout: each stage the release workflow went through, newest first. */
async function releases(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM releases ORDER BY at DESC LIMIT 40").all();
  return json({ current: env.VERSION, stages: results });
}

/** golive-gate posts {"input": case input}; answer {"output": proposal, "cost_usd": n}. */
async function handleEval(req: Request, env: Env) {
  if (!env.EVAL_TOKEN || req.headers.get("authorization") !== `Bearer ${env.EVAL_TOKEN}`) return json({ error: "unauthorized" }, 401);
  const { input } = (await req.json()) as { input: CaseInput };
  const makeModel = (w: World, b: FacilityBehavior): Model =>
    env.MODEL_MODE.startsWith("scripted") ? new ScriptedModel(input.facts as never, b, w, env.MODEL_MODE === "scripted-naive") : new ClaudeModel(requireKey(env));
  const { output, cost_usd } = await runCase(input, WORLD, makeModel);
  if (cost_usd > 0) await addSpend(env.DB, cost_usd, "eval:");
  return json({ output, cost_usd, version: env.VERSION });
}

async function handleMessage(req: Request, env: Env) {
  const body = (await req.json()) as { conversation_id?: string; from?: string; message?: string };
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  if ((await hit(env.DB, `ip:${ip}`)) > WEB_LIMIT) return json({ error: "This address has sent a lot of messages today. Please try again tomorrow." }, 429);
  const r = await converse(env, { id: body.conversation_id, sender: body.from ?? "", text: body.message ?? "", channel: "web" });
  if ("error" in r) return json({ error: r.error }, r.status);
  const steps = r.result.steps.filter((s) => s.kind === "tool").map((s: any) => ({ name: s.name, ok: s.ok, status: s.output?.status ?? null, error: s.error ?? null }));
  return json({
    conversation_id: r.id,
    reply: r.result.reply,
    result: proposalFrom(r.result.steps, r.result.reply, r.result.stopped),
    calendar: calendarFor(r.world, r.result.steps, r.before),
    steps,
    trace_url: `/trace/${r.id}`,
    version: env.VERSION,
  });
}

const WEB_LIMIT = 30; // messages per IP address per day
const EMAIL_LIMIT = 10; // emails per sender per day

type Turn = { id?: string; sender: string; text: string; channel: "web" | "email" };
type Conversed =
  | { error: string; status: number }
  | { id: string; result: AgentResult; world: World; before: World };

/** One turn of a conversation, from the web inbox or an email: load the history, run the agent, save the trace. */
async function converse(env: Env, t: Turn): Promise<Conversed> {
  if (env.MODEL_MODE !== "claude" || !env.ANTHROPIC_API_KEY) return { error: "The live model is not configured on this deploy.", status: 503 };
  const text = t.text.trim().slice(0, 4000);
  if (!text) return { error: "empty message", status: 400 };
  if ((await spentToday(env.DB)) >= Number(env.DAILY_BUDGET_USD || "5"))
    return { error: "The demo has used today's budget. Please try again tomorrow.", status: 429 };

  const now = new Date().toISOString();
  let id = t.id;
  let history: BetaMessageParam[] = [];
  let sender = t.sender.trim().slice(0, 120) || "unknown sender";
  if (id) {
    const row = await env.DB.prepare("SELECT messages, sender FROM conversations WHERE id = ?").bind(id).first<{ messages: string; sender: string }>();
    if (!row) return { error: "unknown conversation", status: 404 };
    history = JSON.parse(row.messages);
    sender = row.sender;
  } else {
    id = crypto.randomUUID();
  }
  if (history.length > 40) return { error: "This conversation is too long. Please start a new one.", status: 400 };
  const userText = history.length
    ? `--- Reply from ${sender}, received ${new Date().toISOString().slice(0, 16)}Z\n\n${text}`
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
    ).bind(id, now, now, `${t.channel}: ${sender}`, env.VERSION, JSON.stringify(result.messages), result.cost_usd, result.cost_usd),
    env.DB.prepare(
      "INSERT INTO turns (conversation_id, turn, created_at, version, user_text, reply, stopped, steps, cost_usd, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, turn, now, env.VERSION, text, result.reply, result.stopped, JSON.stringify(result.steps), result.cost_usd, ms),
  ]);
  await addSpend(env.DB, result.cost_usd);
  return { id, result, world: await store.world(), before };
}

/** Inbound email at appointments@: thread by Message-ID, run the agent, reply in the same thread with a trace link. */
async function handleEmail(message: ForwardableEmailMessage, env: Env) {
  const self = env.EMAIL_ADDRESS || message.to;
  const from = message.from;
  const skip = skipReason(from, message.headers, self);
  if (skip) return console.log(`email from ${from} skipped: ${skip}`);
  const parsed = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
  const messageId = parsed.messageId || message.headers.get("message-id") || `<${crypto.randomUUID()}@inbound.invalid>`;
  if (await env.DB.prepare("SELECT 1 FROM email_ids WHERE message_id = ?").bind(messageId).first()) return console.log(`duplicate ${messageId}`);

  const keys = threadKeys(parsed.inReplyTo ?? message.headers.get("in-reply-to"), parsed.references ?? message.headers.get("references"));
  let conversation: string | undefined;
  for (const k of keys) {
    const row = await env.DB.prepare("SELECT conversation_id FROM email_ids WHERE message_id = ?").bind(k).first<{ conversation_id: string }>();
    if (row) { conversation = row.conversation_id; break; }
  }
  const subject = parsed.subject ?? "";
  const plain = parsed.text ?? (parsed.html ?? "").replace(/<[^>]+>/g, " ");
  const body = newText(plain);
  const text = conversation ? body : `Subject: ${subject}\n\n${body}`;

  let replyBody: string;
  let convId = conversation;
  if ((await hit(env.DB, `email:${from.toLowerCase()}`)) > EMAIL_LIMIT) {
    replyBody = "Thanks for your email. This demo answers up to 10 emails per sender per day, and you have reached that today. Please try again tomorrow.";
  } else {
    const r = await converse(env, { id: conversation, sender: parsed.from?.name ? `${parsed.from.name} <${from}>` : from, text, channel: "email" });
    if ("error" in r) {
      replyBody = `Thanks for your email. The appointment desk could not take it just now. ${r.error}`;
    } else {
      convId = r.id;
      replyBody = plainText(r.result.reply);
    }
  }
  const base = (env.PUBLIC_URL || "").replace(/\/$/, "");
  const footer = `\n\n--\nLanternfly Logistics appointment desk. This is a demo: an AI agent answers, and the loads, facilities and appointments are made up.${
    convId && base ? `\nEvery step it took on this thread: ${base}/trace/${convId}` : ""
  }`;
  const domain = self.split("@")[1] ?? "inbound.invalid";
  const replyId = `<${crypto.randomUUID()}@${domain}>`;
  const raw = buildReply({
    from: self, fromName: "Lanternfly appointment desk", to: from, subject, inReplyTo: messageId,
    references: keys.slice().reverse(), messageId: replyId, date: new Date(), body: replyBody + footer,
  });
  const now = new Date().toISOString();
  if (convId)
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO email_ids (message_id, conversation_id, direction, created_at) VALUES (?, ?, 'in', ?)").bind(messageId, convId, now),
      env.DB.prepare("INSERT OR IGNORE INTO email_ids (message_id, conversation_id, direction, created_at) VALUES (?, ?, 'out', ?)").bind(replyId, convId, now),
    ]);
  await message.reply(new EmailMessage(self, from, raw));
}

/** Counts one hit for this key today and returns the count so far. */
async function hit(db: D1Database, key: string) {
  const row = await db
    .prepare("INSERT INTO hits (key, day, n) VALUES (?, ?, 1) ON CONFLICT(key, day) DO UPDATE SET n = n + 1 RETURNING n")
    .bind(key, today())
    .first<{ n: number }>();
  return row?.n ?? 1;
}

/** Nightly: put the demo TMS and dock calendars back to the seed, so bookings from the day before are cleared. */
async function resetWorld(env: Env) {
  await env.DB.prepare("INSERT OR REPLACE INTO world (id, doc, updated_at) VALUES (1, ?, datetime('now'))").bind(JSON.stringify(WORLD)).run();
  await env.DB.prepare("DELETE FROM hits WHERE day < ?").bind(today()).run();
}

function requireKey(env: Env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  return env.ANTHROPIC_API_KEY;
}

const today = () => new Date().toISOString().slice(0, 10);

async function spentToday(db: D1Database) {
  const row = await db.prepare("SELECT usd FROM spend WHERE day = ?").bind("live:" + today()).first<{ usd: number }>();
  return row?.usd ?? 0;
}

/** Visitor spend ("live:<day>") counts against the daily budget; the gate's own runs ("eval:<day>") do not. */
async function addSpend(db: D1Database, usd: number, prefix: "live:" | "eval:" = "live:") {
  await db.prepare("INSERT INTO spend (day, usd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd").bind(prefix + today(), usd).run();
}
