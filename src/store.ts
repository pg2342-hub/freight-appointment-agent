import { confirmationFor, facility, msToLocal, openSlots, type Load, type World } from "./world";

/** How a facility answers in the simulation. Eval cases set these; live facilities answer plainly. */
export type FacilityBehavior = {
  portal_errors?: number; // the first N portal requests fail
  counter_offer?: string; // the first request is answered with this slot instead
  question?: string; // the facility asks this before it will book
  po_not_found?: boolean; // the receiver does not have the PO
};

export type RequestOutcome =
  | { status: "confirmed"; confirmation: string; facility: string; local: string; channel: string }
  | { status: "portal_error"; message: string }
  | { status: "counter_offer"; offered_local: string; message: string }
  | { status: "question"; question: string }
  | { status: "rejected"; message: string }
  | { status: "no_answer"; message: string };

export class RequestError extends Error {}

export type Notice = { to: string; load_no: string | null; message: string; flags: string[] };

/**
 * The brokerage's systems as the agent sees them: the TMS (loads), the facilities' dock calendars,
 * and the facilities themselves answering appointment requests.
 */
export abstract class Store {
  protected portalFailures = new Map<string, number>();
  protected countered = new Set<string>();

  constructor(protected behavior: FacilityBehavior = {}) {}

  abstract world(): Promise<World>;
  /** The current time (the email's received time in evals). */
  abstract now(): number;
  protected abstract saveAppointment(load: Load, stop: "pickup" | "delivery", local: string, confirmation: string): Promise<void>;
  abstract recordFcfs(load: Load, facilityId: string): Promise<void>;
  abstract notify(n: Notice): Promise<void>;
  abstract handOff(h: { to: string; reason: string; load_no: string | null; note: string }): Promise<void>;
  /** Persist changes made during a run (the live store writes the TMS back). */
  async commit(): Promise<void> {}

  async recordExisting(load: Load, stop: "pickup" | "delivery", local: string, confirmation: string) {
    await this.saveAppointment(load, stop, local, confirmation);
  }

  async requestAppointment(loadNo: string, facilityId: string, local: string, channel: string): Promise<RequestOutcome> {
    const w = await this.world();
    const load = w.loads.find((l) => l.load_no === loadNo);
    const f = facility(w, facilityId);
    if (!load) throw new RequestError(`no load ${loadNo}`);
    if (!f) throw new RequestError(`no facility ${facilityId}`);
    const stop = load.pickup.facility === f.id ? "pickup" : load.delivery.facility === f.id ? "delivery" : null;
    if (!stop) throw new RequestError(`${loadNo} has no stop at ${f.id}`);
    if (f.fcfs) throw new RequestError(`${f.id} receives first come, first served and takes no appointments`);

    const key = `${loadNo}|${f.id}`;
    const failures = this.portalFailures.get(key) ?? 0;
    const emailFallback = channel === "email" && f.channel === "portal" && failures > 0;
    if (channel !== f.channel && !emailFallback)
      throw new RequestError(`${f.id} books by ${f.channel}${f.channel === "portal" ? " (email only if the portal fails)" : ""}`);

    if (channel === "phone") {
      const nowLocal = msToLocal(this.now(), f.tz).slice(11, 16);
      if (nowLocal < f.open || nowLocal >= f.close)
        return { status: "no_answer", message: `No answer: ${f.id} is open ${f.open}-${f.close} local time` };
    }
    if (channel === "portal" && failures < (this.behavior.portal_errors ?? 0)) {
      this.portalFailures.set(key, failures + 1);
      return { status: "portal_error", message: "Scheduling portal returned an error (HTTP 503). Nothing was booked." };
    }
    if (this.behavior.po_not_found) return { status: "rejected", message: `Receiver: PO ${load.customer_po} is not in our system.` };
    if (this.behavior.question) return { status: "question", question: this.behavior.question };

    const notBefore = msToLocal(this.now() + f.notice_hours * 3600_000, f.tz);
    const open = openSlots(f, notBefore, `${local.slice(0, 10)}T23:59`);
    if (!open.includes(local)) throw new RequestError(`${local} is not an open slot at ${f.id} (closed, booked, or inside its ${f.notice_hours}h notice)`);

    const co = this.behavior.counter_offer;
    if (co && co !== local && !this.countered.has(key)) {
      this.countered.add(key);
      return { status: "counter_offer", offered_local: co, message: `${f.id} cannot take ${local}; offers ${co} instead.` };
    }
    const confirmation = await confirmationFor(f.id, local);
    await this.saveAppointment(load, stop, local, confirmation);
    f.booked.push(local);
    return { status: "confirmed", confirmation, facility: f.id, local, channel };
  }
}

/** One email thread's private copy of the world. The eval endpoint uses it, so cases never touch live data. */
export class MemoryStore extends Store {
  readonly fcfs: { load_no: string; facility: string }[] = [];
  readonly notices: Notice[] = [];
  readonly handoffs: { to: string; reason: string; load_no: string | null; note: string }[] = [];
  private w: World;

  constructor(world: World, private nowMs: number, behavior: FacilityBehavior = {}) {
    super(behavior);
    this.w = structuredClone(world);
  }

  async world() {
    return this.w;
  }
  now() {
    return this.nowMs;
  }
  protected async saveAppointment(load: Load, stop: "pickup" | "delivery", local: string, confirmation: string) {
    load[stop].appt = local;
    load[stop].confirmation = confirmation;
  }
  async recordFcfs(load: Load, facilityId: string) {
    this.fcfs.push({ load_no: load.load_no, facility: facilityId });
  }
  async notify(n: Notice) {
    this.notices.push(n);
  }
  async handOff(h: { to: string; reason: string; load_no: string | null; note: string }) {
    this.handoffs.push(h);
  }
}

