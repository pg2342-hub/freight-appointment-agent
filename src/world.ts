// The brokerage's data: facilities with dock calendars, and loads. seed/world.json is constructed
// data for a fictional brokerage, Lanternfly Logistics. Times without an offset are facility-local.

export type Facility = {
  id: string;
  name: string;
  tz: string;
  channel: "email" | "portal" | "phone" | "fcfs";
  open: string; // "07:00"
  close: string; // "15:00"
  days: number[]; // 0 = Monday ... 6 = Sunday
  notice_hours: number;
  holidays: string[]; // "YYYY-MM-DD"
  booked: string[]; // facility-local "YYYY-MM-DDTHH:MM"
  fcfs: boolean;
};

export type Stop = {
  facility: string;
  appt: string | null;
  window_start?: string;
  window_end?: string;
  must_deliver_by?: string;
  confirmation?: string;
};

export type Load = {
  load_no: string;
  customer_po: string;
  pickup: Stop;
  delivery: Stop;
  miles: number;
  carrier: string | null;
  hazmat: boolean;
};

export type World = {
  company: { name: string; desk: string };
  transit: { mph: number; dwell_hours: number };
  facilities: Facility[];
  loads: Load[];
};

export const facility = (w: World, id: string) => w.facilities.find((f) => f.id === id);

// ---- time ----

/** Minutes east of UTC for a time zone at an instant. */
function offsetMinutes(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((asUtc - Math.floor(utcMs / 60000) * 60000) / 60000);
}

/** Facility-local "YYYY-MM-DDTHH:MM" to an instant (ms). */
export function localToMs(local: string, tz: string): number {
  const [d, t] = local.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = (t ?? "00:00").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm);
  let ms = guess - offsetMinutes(guess, tz) * 60000;
  ms = guess - offsetMinutes(ms, tz) * 60000;
  return ms;
}

/** An instant (ms) to facility-local "YYYY-MM-DDTHH:MM". */
export function msToLocal(ms: number, tz: string): string {
  const shifted = new Date(ms + offsetMinutes(ms, tz) * 60000);
  return shifted.toISOString().slice(0, 16);
}

/** Parse an ISO time with an offset ("2026-12-09T10:00-05:00") or a facility-local time. */
export function parseTime(s: string, tz: string): number {
  return /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? Date.parse(s) : localToMs(s, tz);
}

const HOUR = 3600_000;

export function transitHours(w: World, miles: number): number {
  return w.transit.dwell_hours + Math.ceil(miles / w.transit.mph);
}

// ---- dock calendar ----

function weekday(localDate: string): number {
  return (new Date(`${localDate}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
}

function addDays(localDate: string, n: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + n * 24 * HOUR).toISOString().slice(0, 10);
}

/** Hourly dock slots on open days in [from, to] (facility-local), minus booked ones. */
export function openSlots(f: Facility, fromLocal: string, toLocal: string, extraBooked: string[] = []): string[] {
  const booked = new Set([...f.booked, ...extraBooked]);
  const o = +f.open.slice(0, 2);
  const c = +f.close.slice(0, 2);
  const out: string[] = [];
  for (let d = fromLocal.slice(0, 10); d <= toLocal.slice(0, 10); d = addDays(d, 1)) {
    if (!f.days.includes(weekday(d)) || f.holidays.includes(d)) continue;
    for (let h = o; h < c; h++) {
      const s = `${d}T${String(h).padStart(2, "0")}:00`;
      if (s >= fromLocal.slice(0, 16) && s <= toLocal.slice(0, 16) && !booked.has(s)) out.push(s);
    }
  }
  return out;
}

export function holidaysBetween(f: Facility, fromLocal: string, toLocal: string): string[] {
  return f.holidays.filter((h) => h >= fromLocal.slice(0, 10) && h <= toLocal.slice(0, 10));
}

/** The confirmation number a facility returns for a booking (deterministic in the mock). */
export async function confirmationFor(facilityId: string, local: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${facilityId}${local}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${facilityId}-${hex.slice(0, 5).toUpperCase()}`;
}
