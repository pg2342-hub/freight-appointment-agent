// The eval endpoint's work: run one golive-gate case (an email thread) through the real agent loop on a
// private copy of the data, then read what the agent actually did (its tool calls) back as a proposal.
import { runAgent, type TraceStep } from "./agent";
import type { Model } from "./model";
import { MemoryStore, type FacilityBehavior } from "./store";
import type { World } from "./world";

export type EmailMessage = { from: string; body: string };
export type CaseInput = {
  received_at: string;
  thread: EmailMessage[];
  facts: Record<string, any>;
  facility_response?: FacilityBehavior;
};

/** An email thread as the agent reads it. */
export function threadText(thread: EmailMessage[], receivedAt: string): string {
  const parts = thread.map((m, i) => `--- Email ${i + 1} of ${thread.length}\nFrom: ${m.from}\n\n${m.body.trim()}`);
  return `New email thread to the appointments desk, latest received ${receivedAt}.\n\n${parts.join("\n\n")}`;
}

export async function runCase(input: CaseInput, world: World, makeModel: (w: World, b: FacilityBehavior) => Model) {
  const behavior = input.facility_response ?? {};
  const store = new MemoryStore(world, Date.parse(input.received_at), behavior);
  const w = await store.world();
  const result = await runAgent(makeModel(w, behavior), store, [{ role: "user", content: threadText(input.thread, input.received_at) }]);
  return { output: proposalFrom(result.steps, result.reply, result.stopped), cost_usd: result.cost_usd, steps: result.steps };
}

type ToolStep = Extract<TraceStep, { kind: "tool" }>;

/** What the agent did, in the proposal shape the appointment grader scores. Only successful tool calls count. */
export function proposalFrom(steps: TraceStep[], reply: string, stopped: string) {
  const calls = steps.filter((s): s is ToolStep => s.kind === "tool" && s.ok);
  const of = (name: string) => calls.filter((s) => s.name === name);
  const inp = (s: ToolStep) => s.input as Record<string, any>;
  const out = (s: ToolStep) => s.output as Record<string, any>;
  const log = steps.filter((s): s is ToolStep => s.kind === "tool").map((s) => `${s.name}${s.ok ? "" : ` failed: ${s.error}`}`);
  const notices = of("notify").map(inp);
  const notify = [...new Set(notices.map((n) => n.to))].sort();
  const flags = [...new Set(notices.flatMap((n) => n.flags ?? []))].sort();
  const base = { notify, flags, reply, log: [...log, `stopped: ${stopped}`] };

  const handoff = of("hand_off").map(inp).at(-1);
  if (handoff) return { ...base, action: "handoff", to: handoff.to, reason: handoff.reason, load: handoff.load_no, log: handoff.note };

  const fcfs = of("record_fcfs").map(inp).at(-1);
  if (fcfs) return { ...base, action: "record_fcfs", load: fcfs.load_no, facility: fcfs.facility_id };

  const existing = of("record_existing_appointment").map(inp);
  const requests = of("request_appointment");
  const confirmed = requests.filter((s) => out(s).status === "confirmed");
  if (existing.length && !confirmed.length) {
    return {
      ...base,
      action: "enter_existing",
      load: existing.at(-1)!.load_no,
      confirmation: existing.at(-1)!.confirmation,
      appointments: existing.map((e) => ({ facility: e.facility_id, local: e.local_time.slice(0, 16) })),
    };
  }
  if (confirmed.length) {
    const last = confirmed.at(-1)!;
    const lastFac = out(last).facility;
    // One appointment per stop: a later confirmation at the same facility replaces an earlier one.
    const byFac = new Map<string, string>();
    for (const c of confirmed) byFac.set(out(c).facility, out(c).local);
    return {
      ...base,
      action: existing.length ? "book_and_enter" : "book",
      load: inp(last).load_no,
      appointments: [...byFac].map(([facility, local]) => ({ facility, local })),
      channel: out(last).channel,
      attempts: requests.filter((s) => inp(s).facility_id === lastFac).map((s) => inp(s).channel),
      confirmation: out(last).confirmation,
    };
  }
  return { ...base, action: "none", load: null };
}
