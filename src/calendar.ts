// The data behind the page's dock calendar: for the stop the agent booked, the facility's days and
// hours, closed days, slots already taken, the customer window, the truck's earliest arrival, and
// the appointment. Everything comes from the world and the run's own tool calls.
import type { TraceStep } from "./agent";
import { facility, msToLocal, parseTime, type World } from "./world";

export type DockCalendar = {
  facility: string;
  name: string;
  tz: string;
  open: string;
  close: string;
  days: { date: string; weekday: string; closed: "" | "weekend" | "holiday"; booked: string[] }[];
  window: { start: string; end: string } | null;
  earliest: string | null;
  appointment: string;
};

const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function calendarFor(world: World, steps: TraceStep[], bookedBefore: World): DockCalendar | null {
  const tools = steps.filter((s): s is Extract<TraceStep, { kind: "tool" }> => s.kind === "tool" && s.ok);
  const done = tools.filter((s) => s.name === "request_appointment" && (s.output as any)?.status === "confirmed").at(-1)
    ?? tools.filter((s) => s.name === "record_existing_appointment").at(-1);
  if (!done) return null;
  const inp = done.input as Record<string, string>;
  const f = facility(bookedBefore, inp.facility_id);
  const load = world.loads.find((l) => l.load_no === inp.load_no);
  if (!f || !load) return null;
  const appointment = inp.local_time.slice(0, 16);
  const stop = load.delivery.facility === f.id ? load.delivery : load.pickup;
  const arrival = tools.filter((s) => s.name === "estimate_arrival").map((s) => (s.output as any).earliest_arrival_local as string).at(-1);
  const notBefore = tools
    .filter((s) => s.name === "get_open_slots" && (s.input as any).facility_id === f.id && (s.input as any).not_before)
    .map((s) => msToLocal(parseTime((s.input as any).not_before, f.tz), f.tz))
    .at(-1);
  const earliest = stop === load.delivery ? notBefore ?? arrival ?? null : null;

  const startDate = [stop.window_start ?? appointment, earliest ?? appointment, appointment].sort()[0].slice(0, 10);
  const lastDate = [stop.window_end ?? appointment, appointment].sort().at(-1)!.slice(0, 10);
  const days: DockCalendar["days"] = [];
  for (let d = startDate; d <= lastDate && days.length < 14; d = next(d)) {
    const wd = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
    const closed = f.holidays.includes(d) ? "holiday" : f.days.includes(wd) ? "" : "weekend";
    days.push({ date: d, weekday: WD[wd], closed, booked: f.booked.filter((b) => b.startsWith(d)).map((b) => b.slice(11)) });
  }
  return {
    facility: f.id,
    name: f.name,
    tz: f.tz,
    open: f.open,
    close: f.close,
    days,
    window: stop.window_start && stop.window_end ? { start: stop.window_start, end: stop.window_end } : null,
    earliest,
    appointment,
  };
}

function next(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
}
