// The agent's tools. Each validates its input and goes through the Store: the TMS, the dock calendars,
// and the facilities answering requests. A facility refuses what a real one would refuse.
import { z } from "zod";
import { RequestError, type Store } from "./store";
import { facility, holidaysBetween, msToLocal, openSlots, parseTime, transitHours } from "./world";

export class ToolError extends Error {}

export const HANDOFF_REASONS = [
  "load_not_found",
  "no_slot_in_window",
  "date_conflict",
  "late_to_receiver",
  "facility_question",
  "competing_loads",
  "po_not_found",
  "counter_offer_infeasible",
  "hazmat",
  "changes_load",
  "out_of_scope",
] as const;

type ToolDef<S extends z.ZodTypeAny> = { name: string; description: string; schema: S; run: (input: z.infer<S>, store: Store) => Promise<unknown> };
const tool = <S extends z.ZodTypeAny>(d: ToolDef<S>) => d;

const findLoad = tool({
  name: "find_load",
  description:
    "Find loads in the TMS by the customer's PO number or our load number. A customer PO can match more than one load; " +
    "pass the facility named in the email to narrow it down. Returns each load's stops (facility, appointment, customer window, " +
    "must-deliver-by), miles, carrier and hazmat flag. Times are local to each stop's facility.",
  schema: z.object({
    reference: z.string().describe("A customer PO (e.g. PO-40101 or 4500123981) or a load number (e.g. L-20401)"),
    facility_id: z.string().optional().describe("Only loads with a stop at this facility"),
  }),
  run: async ({ reference, facility_id }, store) => {
    const w = await store.world();
    const ref = reference.trim();
    let loads = w.loads.filter((l) => l.customer_po === ref || l.load_no === ref);
    if (facility_id) loads = loads.filter((l) => [l.pickup.facility, l.delivery.facility].includes(facility_id));
    return { matches: loads.length, loads };
  },
});

const getFacility = tool({
  name: "get_facility",
  description:
    "A facility's scheduling rules: time zone, dock hours, open weekdays, holidays, notice required, how it books " +
    "(email, portal, phone, or fcfs = first come, first served with no appointments).",
  schema: z.object({ facility_id: z.string() }),
  run: async ({ facility_id }, store) => {
    const f = facility(await store.world(), facility_id);
    if (!f) throw new ToolError(`no facility ${facility_id}`);
    const { booked: _b, days, ...rest } = f;
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return { ...rest, open_days: days.map((d) => names[d]) };
  },
});

const estimateArrival = tool({
  name: "estimate_arrival",
  description:
    "Earliest the truck can reach the delivery facility: departure (the pickup appointment, or a pickup time you give) plus " +
    "transit at 50 mph and one hour at the dock. Answers in the delivery facility's local time.",
  schema: z.object({
    load_no: z.string(),
    pickup_local: z.string().optional().describe("Pickup time in the pickup facility's local time, if not the booked pickup appointment"),
  }),
  run: async ({ load_no, pickup_local }, store) => {
    const w = await store.world();
    const load = w.loads.find((l) => l.load_no === load_no);
    if (!load) throw new ToolError(`no load ${load_no}`);
    const pf = facility(w, load.pickup.facility)!;
    const df = facility(w, load.delivery.facility)!;
    const dep = pickup_local ?? load.pickup.appt;
    if (!dep) throw new ToolError("the pickup has no appointment yet; pass pickup_local");
    const hours = transitHours(w, load.miles);
    const arrive = parseTime(dep, pf.tz) + hours * 3600_000;
    return { load_no, miles: load.miles, transit_hours: hours, depart: `${dep} ${pf.tz}`, earliest_arrival_local: msToLocal(arrive, df.tz), delivery_tz: df.tz };
  },
});

const getOpenSlots = tool({
  name: "get_open_slots",
  description:
    "Open hourly dock slots at a facility between two facility-local times, earliest first. It leaves out closed days, " +
    "holidays, booked slots and anything inside the facility's notice period, and says which of those removed slots. " +
    "not_before takes a time with a UTC offset (e.g. a carrier's ETA, 2026-12-09T10:00-05:00) or a facility-local time.",
  schema: z.object({
    facility_id: z.string(),
    from_local: z.string().describe("YYYY-MM-DDTHH:MM, facility-local"),
    to_local: z.string().describe("YYYY-MM-DDTHH:MM, facility-local"),
    not_before: z.string().optional(),
  }),
  run: async ({ facility_id, from_local, to_local, not_before }, store) => {
    const f = facility(await store.world(), facility_id);
    if (!f) throw new ToolError(`no facility ${facility_id}`);
    if (f.fcfs) return { facility_id, fcfs: true, slots: [], notes: ["First come, first served: no appointments"] };
    const notes: string[] = [];
    let from = from_local.slice(0, 16);
    if (not_before) {
      const nb = msToLocal(parseTime(not_before, f.tz), f.tz);
      if (nb > from) from = nb;
    }
    const all = openSlots(f, from, to_local);
    const noticeEnd = msToLocal(store.now() + f.notice_hours * 3600_000, f.tz);
    const slots = all.filter((s) => s >= noticeEnd);
    if (slots.length < all.length) notes.push(`${all.length - slots.length} slot(s) before ${noticeEnd} removed: ${f.id} needs ${f.notice_hours} hours notice`);
    const hol = holidaysBetween(f, from_local, to_local);
    if (hol.length) notes.push(`closed for holidays: ${hol.join(", ")}`);
    return { facility_id, tz: f.tz, channel: f.channel, slots: slots.slice(0, 24), more: slots.length > 24, notes };
  },
});

const requestAppointment = tool({
  name: "request_appointment",
  description:
    "Ask a facility for an appointment through its booking channel (email, portal or phone). The facility answers: confirmed " +
    "(with its confirmation number), portal_error, counter_offer, question, rejected or no_answer. A confirmed answer is " +
    "written to the TMS and replaces any earlier appointment at that stop.",
  schema: z.object({
    load_no: z.string(),
    facility_id: z.string(),
    local_time: z.string().describe("YYYY-MM-DDTHH:MM, facility-local, from get_open_slots"),
    channel: z.enum(["email", "portal", "phone"]),
  }),
  run: async ({ load_no, facility_id, local_time, channel }, store) => {
    try {
      return await store.requestAppointment(load_no, facility_id, local_time.slice(0, 16), channel);
    } catch (e) {
      if (e instanceof RequestError) throw new ToolError(e.message);
      throw e;
    }
  },
});

const recordExisting = tool({
  name: "record_existing_appointment",
  description: "Write an appointment someone else already booked (with its confirmation number) to the TMS, without booking again.",
  schema: z.object({ load_no: z.string(), facility_id: z.string(), local_time: z.string(), confirmation: z.string() }),
  run: async (input, store) => {
    const w = await store.world();
    const load = w.loads.find((l) => l.load_no === input.load_no);
    if (!load) throw new ToolError(`no load ${input.load_no}`);
    const stop = load.delivery.facility === input.facility_id ? load.delivery : load.pickup.facility === input.facility_id ? load.pickup : null;
    if (!stop) throw new ToolError(`${input.load_no} has no stop at ${input.facility_id}`);
    await store.recordExisting(load, stop === load.delivery ? "delivery" : "pickup", input.local_time.slice(0, 16), input.confirmation);
    return { recorded: true, ...input };
  },
});

const recordFcfs = tool({
  name: "record_fcfs",
  description: "Mark a stop at a first-come, first-served facility as needing no appointment, with its receiving hours.",
  schema: z.object({ load_no: z.string(), facility_id: z.string() }),
  run: async ({ load_no, facility_id }, store) => {
    const w = await store.world();
    const load = w.loads.find((l) => l.load_no === load_no);
    const f = facility(w, facility_id);
    if (!load || !f) throw new ToolError("unknown load or facility");
    if (!f.fcfs) throw new ToolError(`${facility_id} takes appointments; it is not first come, first served`);
    await store.recordFcfs(load, facility_id);
    return { recorded: true, receiving_hours: `${f.open}-${f.close}` };
  },
});

const notify = tool({
  name: "notify",
  description:
    "Send a short update to the carrier on the load or to the account executive (ae) who owns the customer. Use flags to tell " +
    "the ae why: holiday (a closure pushed the date) or notice (a notice rule pushed the date).",
  schema: z.object({
    to: z.enum(["carrier", "ae"]),
    load_no: z.string(),
    message: z.string(),
    flags: z.array(z.enum(["holiday", "notice"])).default([]),
  }),
  run: async (input, store) => {
    await store.notify({ ...input, flags: input.flags ?? [] });
    return { sent: true };
  },
});

const handOff = tool({
  name: "hand_off",
  description:
    "Pass the thread to a person instead of finishing it: the coordinator (dock and scheduling problems, hazmat, anything that is " +
    "not an appointment request) or the account executive, ae (the customer's data or load details are wrong or must change).",
  schema: z.object({
    to: z.enum(["coordinator", "ae"]),
    reason: z.enum(HANDOFF_REASONS),
    load_no: z.string().nullable(),
    note: z.string().describe("One or two sentences the person can act on without rereading the thread"),
  }),
  run: async (input, store) => {
    await store.handOff(input);
    return { handed_off: true };
  },
});

export const TOOLS = [findLoad, getFacility, estimateArrival, getOpenSlots, requestAppointment, recordExisting, recordFcfs, notify, handOff];

export const TOOL_PARAMS = TOOLS.map((t) => {
  const { $schema: _s, ...input_schema } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
  return { name: t.name, description: t.description, input_schema: input_schema as { type: "object" } };
});

export type ToolOutcome = { ok: boolean; output: unknown; error?: string };

export async function runTool(name: string, rawInput: unknown, store: Store): Promise<ToolOutcome> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { ok: false, output: null, error: `unknown tool '${name}'` };
  const parsed = t.schema.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, output: null, error: `invalid input: ${parsed.error.message}` };
  try {
    return { ok: true, output: await t.run(parsed.data as never, store) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, output: null, error: e.message };
    throw e;
  }
}
