// One page per conversation: every turn, every model call and every tool call, with timing and cost.
import type { TraceStep } from "./agent";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Turn = { turn: number; created_at: string; version: string; user_text: string; reply: string; stopped: string; steps: string; cost_usd: number; ms: number };

export async function tracePage(db: D1Database, id: string): Promise<Response> {
  const { results } = await db.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY turn").bind(id).all<Turn>();
  if (!results.length) return new Response("No trace with that id.", { status: 404 });
  const total = results.reduce((a, t) => a + t.cost_usd, 0);
  const body = results.map(turnHtml).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thread trace</title><link rel="stylesheet" href="https://pranavgudise.dev/kit/demo.css">
<style>.step{border-left:2px solid var(--rule,#ddd);padding:.25rem 0 .25rem .75rem;margin:.5rem 0}
.step pre{white-space:pre-wrap;word-break:break-word;font-size:.8rem;margin:.25rem 0 0}.meta{font-size:.8rem;opacity:.75}
.err{border-left-style:dashed}</style></head><body><main>
<p><a href="/">Back to the appointments desk</a></p>
<h1>Thread trace</h1>
<p class="meta">${esc(id)} · ${results.length} turn(s) · $${total.toFixed(4)} total · version ${esc(results[0].version)}</p>
${body}</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function turnHtml(t: Turn): string {
  const steps = (JSON.parse(t.steps) as TraceStep[]).map(stepHtml).join("\n");
  return `<section><h2>Turn ${t.turn}</h2>
<p class="meta">${esc(t.created_at)} · ${t.ms} ms · $${t.cost_usd.toFixed(4)} · ${esc(t.stopped)}</p>
<p><strong>Email:</strong> ${esc(t.user_text)}</p>${steps}
<p><strong>Reply:</strong> ${esc(t.reply)}</p></section>`;
}

function stepHtml(s: TraceStep): string {
  if (s.kind === "model") {
    return `<div class="step"><span class="meta">model ${esc(s.served_by)} · ${s.ms} ms · ${s.input_tokens} in (${s.cache_read_tokens} cached) / ${s.output_tokens} out · $${s.cost_usd.toFixed(4)} · ${esc(s.stop_reason)}</span>${
      s.text ? `<pre>${esc(s.text)}</pre>` : ""
    }</div>`;
  }
  const out = s.ok ? JSON.stringify(s.output, null, 1) : `error: ${s.error}`;
  return `<div class="step${s.ok ? "" : " err"}"><span class="meta">tool <strong>${esc(s.name)}</strong> · ${s.ms} ms</span>
<pre>${esc(JSON.stringify(s.input))}</pre><pre>${esc(out.length > 1500 ? out.slice(0, 1500) + " …" : out)}</pre></div>`;
}
