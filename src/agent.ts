// The tool loop. One call to runAgent handles one email (or chat message): it calls the model, runs the
// tools it asks for, feeds the results back, and stops when the model writes its reply.
// Every model call and tool call is written to the trace.
import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { costUsd, type Model } from "./model";
import { systemPrompt } from "./prompt";
import type { Store } from "./store";
import { TOOL_PARAMS, runTool } from "./tools";

export const MAX_STEPS = 8;

export type TraceStep =
  | {
      kind: "model";
      model: string;
      served_by: string;
      stop_reason: string | null;
      ms: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cost_usd: number;
      text: string;
    }
  | { kind: "tool"; name: string; input: unknown; ok: boolean; output: unknown; error?: string; ms: number };

export type AgentResult = {
  reply: string;
  messages: BetaMessageParam[];
  steps: TraceStep[];
  cost_usd: number;
  stopped: "answered" | "step_limit" | "refusal" | "max_tokens";
};

export async function runAgent(model: Model, store: Store, history: BetaMessageParam[]): Promise<AgentResult> {
  const world = await store.world();
  const prompt = systemPrompt(world, new Date(store.now()).toISOString().slice(0, 16) + "Z");
  const messages = [...history];
  const steps: TraceStep[] = [];
  let cost = 0;

  for (let i = 0; i < MAX_STEPS; i++) {
    const t0 = Date.now();
    const res = await model.create({
      max_tokens: 8000,
      system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }],
      tools: TOOL_PARAMS,
      messages,
    });
    const stepCost = costUsd(res.usage);
    cost += stepCost;
    const text = textOf(res.content);
    steps.push({
      kind: "model",
      model: model.name,
      served_by: res.model,
      stop_reason: res.stop_reason,
      ms: Date.now() - t0,
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      cache_read_tokens: res.usage.cache_read_input_tokens ?? 0,
      cost_usd: stepCost,
      text,
    });

    // A refusal or a cut-off answer can carry a half-written tool call; never run it.
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      const reply = "Sorry, I can't finish this one. Let me get a person to help you.";
      messages.push({ role: "assistant", content: reply });
      return { reply, messages, steps, cost_usd: cost, stopped: res.stop_reason };
    }
    messages.push({ role: "assistant", content: res.content } as BetaMessageParam);
    if (res.stop_reason !== "tool_use" && res.stop_reason !== "pause_turn") {
      return { reply: text, messages, steps, cost_usd: cost, stopped: "answered" };
    }
    if (res.stop_reason === "pause_turn") continue;

    const results: BetaToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const t1 = Date.now();
      const out = await runTool(block.name, block.input, store);
      steps.push({ kind: "tool", name: block.name, input: block.input, ...out, ms: Date.now() - t1 });
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(out.ok ? out.output : { error: out.error }),
        ...(out.ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: "user", content: results });
  }
  const reply = "Sorry, this is taking longer than it should. Let me get a person to help you.";
  return { reply, messages, steps, cost_usd: cost, stopped: "step_limit" };
}

function textOf(content: BetaContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
}
