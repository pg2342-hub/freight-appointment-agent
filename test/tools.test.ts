import assert from "node:assert/strict";
import { test } from "node:test";
import world from "../seed/world.json" with { type: "json" };
import { MemoryStore } from "../src/store";
import { runTool, TOOL_PARAMS } from "../src/tools";
import { localToMs, msToLocal, type World } from "../src/world";

const W = world as unknown as World;
const NOW = Date.parse("2026-12-07T08:00-06:00");
const req = (load_no: string, facility_id: string, local_time: string, channel: string) => ({ load_no, facility_id, local_time, channel });

test("every tool has an object schema", () => {
  for (const t of TOOL_PARAMS) assert.equal(t.input_schema.type, "object", t.name);
});

test("time zones round-trip, including across DST-free December", () => {
  assert.equal(msToLocal(Date.parse("2026-12-09T10:00-05:00"), "America/Chicago"), "2026-12-09T09:00");
  assert.equal(localToMs("2026-12-08T13:00", "America/Chicago"), Date.parse("2026-12-08T19:00Z"));
  assert.equal(msToLocal(Date.parse("2026-07-01T12:00Z"), "America/Denver"), "2026-07-01T06:00");
});

test("a PO shared by two loads is narrowed by facility", async () => {
  const s = new MemoryStore(W, NOW);
  assert.equal(((await runTool("find_load", { reference: "4500123981" }, s)).output as any).matches, 2);
  const one = (await runTool("find_load", { reference: "4500123981", facility_id: "CIN-RCV" }, s)).output as any;
  assert.equal(one.loads[0].load_no, "L-20415");
});

test("a facility refuses the wrong channel, a closed slot and fcfs bookings", async () => {
  const s = new MemoryStore(W, NOW);
  assert.match((await runTool("request_appointment", req("L-20401", "CIN-RCV", "2026-12-09T07:00", "portal"), s)).error!, /books by email/);
  assert.match((await runTool("request_appointment", req("L-20401", "CIN-RCV", "2026-12-09T16:00", "email"), s)).error!, /not an open slot/);
  assert.match((await runTool("request_appointment", req("L-20403", "LOU-FCFS", "2026-12-09T07:00", "email"), s)).error!, /first come/);
});

test("the notice rule blocks slots inside 48 hours", async () => {
  const s = new MemoryStore(W, Date.parse("2026-12-08T06:00-06:00"));
  assert.match((await runTool("request_appointment", req("L-20412", "NSH-DC", "2026-12-08T07:00", "email"), s)).error!, /notice/);
  const slots = (await runTool("get_open_slots", { facility_id: "NSH-DC", from_local: "2026-12-08T00:00", to_local: "2026-12-10T23:59" }, s)).output as any;
  assert.equal(slots.slots[0], "2026-12-10T07:00");
  assert.match(slots.notes[0], /48 hours notice/);
});

test("portal: two failures, then email is accepted as the fallback", async () => {
  const s = new MemoryStore(W, NOW, { portal_errors: 2 });
  assert.match((await runTool("request_appointment", req("L-20413", "KNX-DC", "2026-12-09T07:00", "email"), s)).error!, /email only if the portal fails/);
  const r = req("L-20413", "KNX-DC", "2026-12-09T07:00", "portal");
  assert.equal(((await runTool("request_appointment", r, s)).output as any).status, "portal_error");
  assert.equal(((await runTool("request_appointment", r, s)).output as any).status, "portal_error");
  const ok = (await runTool("request_appointment", { ...r, channel: "email" }, s)).output as any;
  assert.equal(ok.status, "confirmed");
  assert.match(ok.confirmation, /^KNX-DC-[0-9A-F]{5}$/);
});

test("a confirmed slot is taken for the next load", async () => {
  const s = new MemoryStore(W, NOW);
  assert.equal(((await runTool("request_appointment", req("L-20401", "CIN-RCV", "2026-12-09T07:00", "email"), s)).output as any).status, "confirmed");
  assert.match((await runTool("request_appointment", req("L-20407", "CIN-RCV", "2026-12-09T07:00", "email"), s)).error!, /not an open slot/);
});

test("arrival estimate converts to the delivery time zone", async () => {
  const out = (await runTool("estimate_arrival", { load_no: "L-20409" }, new MemoryStore(W, NOW))).output as any;
  assert.equal(out.earliest_arrival_local, "2026-12-08T14:00");
});
