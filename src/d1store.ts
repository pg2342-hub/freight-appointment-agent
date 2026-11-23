import { Store, type FacilityBehavior, type Notice } from "./store";
import type { Load, World } from "./world";

/**
 * The live store: the TMS and dock calendars as one document in Cloudflare D1, plus an events table
 * for notices, hand-offs and appointments. Facilities answer plainly (no simulated failures).
 */
export class D1Store extends Store {
  private cached: World | null = null;
  private dirty = false;

  constructor(private db: D1Database, private threadId: string, behavior: FacilityBehavior = {}) {
    super(behavior);
  }

  async world() {
    if (!this.cached) {
      const row = await this.db.prepare("SELECT doc FROM world WHERE id = 1").first<{ doc: string }>();
      if (!row) throw new Error("world not seeded; run npm run seed");
      this.cached = JSON.parse(row.doc) as World;
    }
    return this.cached;
  }

  now() {
    return Date.now();
  }

  private event(kind: string, data: unknown) {
    return this.db
      .prepare("INSERT INTO events (thread_id, created_at, kind, data) VALUES (?, datetime('now'), ?, ?)")
      .bind(this.threadId, kind, JSON.stringify(data))
      .run();
  }

  protected async saveAppointment(load: Load, stop: "pickup" | "delivery", local: string, confirmation: string) {
    load[stop].appt = local;
    load[stop].confirmation = confirmation;
    this.dirty = true;
    await this.event("appointment", { load_no: load.load_no, stop, local, confirmation });
  }

  async recordFcfs(load: Load, facilityId: string) {
    await this.event("fcfs", { load_no: load.load_no, facility: facilityId });
  }

  async notify(n: Notice) {
    await this.event("notify", n);
  }

  async handOff(h: { to: string; reason: string; load_no: string | null; note: string }) {
    await this.event("handoff", h);
  }

  /** Write the TMS back if anything changed in this run. */
  async commit() {
    if (this.dirty && this.cached)
      await this.db.prepare("UPDATE world SET doc = ?, updated_at = datetime('now') WHERE id = 1").bind(JSON.stringify(this.cached)).run();
  }
}
