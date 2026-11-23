import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { FacilityBehavior } from "./store";
import { facility, holidaysBetween, localToMs, msToLocal, openSlots, parseTime, transitHours, type Load, type World } from "./world";

export const MODEL = "claude-opus-5-5";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// Claude Opus 5.5 list prices, USD per million tokens.
const PRICE = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 };

export type ModelRequest = Omit<MessageCreateParamsNonStreaming, "model" | "betas" | "fallbacks">;

export interface Model {
  readonly name: string;
  create(req: ModelRequest): Promise<BetaMessage>;
}

export function costUsd(usage: BetaMessage["usage"]): number {
  const u = usage as BetaMessage["usage"] & Record<string, number | null>;
  return (
    ((u.input_tokens ?? 0) * PRICE.input +
      (u.output_tokens ?? 0) * PRICE.output +
      (u.cache_read_input_tokens ?? 0) * PRICE.cache_read +
      (u.cache_creation_input_tokens ?? 0) * PRICE.cache_write) /
    1e6
  );
}

/** Claude through the Anthropic SDK, with server-side fallback if the model declines. */
export class ClaudeModel implements Model {
  readonly name = MODEL;
  private client: Anthropic;

  constructor(apiKey: string, private effort: "low" | "medium" | "high" = "medium") {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  create(req: ModelRequest) {
    return this.client.beta.messages.create({
      ...req,
      model: MODEL,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: this.effort },
    });
  }
}

type Facts = {
  received_at: string;
  intent?: string;
  kind?: string;
  stop?: "pickup" | "delivery" | "both";
  check_call_eta?: string;
  emails: Record<string, string>[];
};
type Call = [string, Record<string, unknown>];

/**
 * A scripted stand-in for Claude, used where there is no API key (local tests, CI on forks).
 * It reads the eval case's structured facts, which the real model never sees, and calls the
 * same tools a correct agent would. It proves the tools, facility simulation, traces and the
 * gate work end to end; it says nothing about how well Claude handles the emails.
 */
export class ScriptedModel implements Model {
  readonly name = "scripted";
  private turn = 0;

  constructor(private facts: Facts, private behavior: FacilityBehavior, private world: World) {}

  async create(_req: ModelRequest): Promise<BetaMessage> {
    this.turn += 1;
    if (this.turn > 1) return message([{ type: "text", text: "Done. (scripted stand-in)" }], "end_turn");
    const calls = this.plan().map(([name, input], i) => ({ type: "tool_use", id: `toolu_s${i}`, name, input }));
    return message(calls, "tool_use");
  }

  private plan(): Call[] {
    const w = this.world;
    const f = this.facts;
    const b = this.behavior;
    const received = Date.parse(f.received_at);
    const merged: Record<string, string> = {};
    for (const e of f.emails) for (const [k, v] of Object.entries(e)) if (!(k in merged)) merged[k] = v;
    const pos = [...new Set(f.emails.filter((e) => e.po).map((e) => e.po))];
    const fac = merged.facility;
    const calls: Call[] = [];
    const handoff = (to: string, reason: string, load_no: string | null, note: string): Call[] => [
      ...calls,
      ["hand_off", { to, reason, load_no, note }],
    ];

    const loads: Load[] = [];
    for (const po of pos) {
      calls.push(["find_load", { reference: po, ...(fac ? { facility_id: fac } : {}) }]);
      const hit = w.loads.find((l) => (l.customer_po === po || l.load_no === po) && (!fac || [l.pickup.facility, l.delivery.facility].includes(fac)));
      if (hit) loads.push(hit);
    }
    if (!loads.length) return handoff("ae", "load_not_found", null, "No load matches the PO and facility.");
    const load = loads[0];
    const ln = load.load_no;

    const intent = f.intent ?? "appointment";
    if (intent === "address_change") return handoff("ae", "changes_load", ln, "Address change alters the load.");
    if (intent !== "appointment") return handoff("coordinator", "out_of_scope", ln, `Not an appointment request (${intent}).`);
    if (load.hazmat) return handoff("coordinator", "hazmat", ln, "Hazmat load needs special facility instructions.");
    if (merged.requested_date) {
      const ws = load.delivery.window_start!.slice(0, 10);
      const we = load.delivery.window_end!.slice(0, 10);
      if (merged.requested_date < ws || merged.requested_date > we)
        return handoff("ae", "date_conflict", ln, `Email asks for ${merged.requested_date}; TMS window is ${ws} to ${we}.`);
    }
    if (b.po_not_found) return handoff("ae", "po_not_found", ln, "Receiver says the PO is not in its system.");
    if (b.question) return handoff("coordinator", "facility_question", ln, `Facility asked: ${b.question}`);

    const stop = f.stop ?? "delivery";
    const dfac = facility(w, load.delivery.facility)!;
    if (stop === "delivery" && dfac.fcfs) {
      calls.push(["record_fcfs", { load_no: ln, facility_id: dfac.id }]);
      if (load.carrier) calls.push(["notify", { to: "carrier", load_no: ln, message: "First come, first served.", flags: [] }]);
      return calls;
    }
    if (merged.existing_appt) {
      calls.push(["record_existing_appointment", { load_no: ln, facility_id: dfac.id, local_time: merged.existing_appt, confirmation: merged.confirmation }]);
      return calls;
    }

    const flags = new Set<string>();
    const notify = new Set<string>();
    let pickupLocal: string | null = null;
    if (stop === "pickup" || stop === "both") {
      const p = load.pickup;
      const slot = this.pick(p.facility, p.window_start!, p.window_end!, received, null, flags, 1);
      if (!slot || slot === "competing") return handoff("coordinator", "no_slot_in_window", ln, "No pickup slot inside the window.");
      this.request(calls, ln, p.facility, slot);
      pickupLocal = slot;
      if (stop === "pickup") return this.finish(calls, load, flags, notify);
    }

    const pf = facility(w, load.pickup.facility)!;
    const earliest = f.check_call_eta
      ? Date.parse(f.check_call_eta)
      : parseTime((pickupLocal ?? load.pickup.appt)!, pf.tz) + transitHours(w, load.miles) * 3600_000;
    const d = load.delivery;
    const slot = this.pick(dfac.id, d.window_start!, d.window_end!, received, earliest, flags, loads.length);
    if (slot === "competing") return handoff("coordinator", "competing_loads", ln, `${loads.length} loads and too few slots at ${dfac.id}.`);
    if (!slot) return handoff("coordinator", "no_slot_in_window", ln, `No slot inside the window at ${dfac.id}.`);
    if (d.must_deliver_by && slot > d.must_deliver_by)
      return handoff("coordinator", "late_to_receiver", ln, `Earliest slot ${slot} is after the deadline ${d.must_deliver_by}.`);
    this.request(calls, ln, dfac.id, slot);
    if (f.kind === "reschedule") notify.add("ae");
    return this.finish(calls, load, flags, notify);
  }

  private request(calls: Call[], ln: string, facId: string, slot: string) {
    const f = facility(this.world, facId)!;
    let channel: string = f.channel;
    if (channel === "portal" && (this.behavior.portal_errors ?? 0) > 0) {
      calls.push(["request_appointment", { load_no: ln, facility_id: facId, local_time: slot, channel: "portal" }]);
      calls.push(["request_appointment", { load_no: ln, facility_id: facId, local_time: slot, channel: "portal" }]);
      if ((this.behavior.portal_errors ?? 0) >= 2) channel = "email";
    }
    calls.push(["request_appointment", { load_no: ln, facility_id: facId, local_time: slot, channel }]);
    const co = this.behavior.counter_offer;
    if (co && co !== slot) calls.push(["request_appointment", { load_no: ln, facility_id: facId, local_time: co, channel }]);
  }

  private finish(calls: Call[], load: Load, flags: Set<string>, notify: Set<string>): Call[] {
    if (load.carrier) notify.add("carrier");
    if (flags.size) notify.add("ae");
    for (const to of [...notify].sort())
      calls.push(["notify", { to, load_no: load.load_no, message: "Appointment set.", flags: to === "ae" ? [...flags] : [] }]);
    return calls;
  }

  private pick(facId: string, ws: string, we: string, received: number, earliest: number | null, flags: Set<string>, nLoads: number) {
    const f = facility(this.world, facId)!;
    let slots = openSlots(f, ws, msToLocal(localToMs(ws, f.tz) + 14 * 86400_000, f.tz));
    if (earliest !== null) slots = slots.filter((s) => localToMs(s, f.tz) >= earliest);
    const beforeNotice = slots[0];
    slots = slots.filter((s) => localToMs(s, f.tz) >= received + f.notice_hours * 3600_000);
    const inside = slots.filter((s) => s <= we);
    if (nLoads > 1 && inside.length < nLoads) return "competing" as const;
    if (!inside.length) return null;
    const slot = inside[0];
    if (beforeNotice && slot !== beforeNotice) flags.add("notice");
    if (holidaysBetween(f, ws, slot).some((h) => h < slot.slice(0, 10))) flags.add("holiday");
    return slot;
  }
}

function message(content: unknown[], stop: "end_turn" | "tool_use"): BetaMessage {
  return {
    id: "msg_scripted",
    type: "message",
    role: "assistant",
    model: "scripted",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}
