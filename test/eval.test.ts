import assert from "node:assert/strict";
import { test } from "node:test";
import cases from "../gate/cases.json" with { type: "json" };
import world from "../seed/world.json" with { type: "json" };
import { runCase } from "../src/eval";
import { ScriptedModel } from "../src/model";
import type { World } from "../src/world";

// The scripted stand-in drives the real loop, tools and facility simulation; its proposals must match.
for (const c of (cases as any).cases) {
  test(`case ${c.id} (${c.group}): ${c.title}`, async () => {
    const { output } = await runCase(c.input, world as unknown as World, (w, b) => new ScriptedModel(c.input.facts, b, w));
    const o = output as any;
    assert.equal(o.action, c.expected.action, JSON.stringify(o.log));
    if (c.expected.load) assert.equal(o.load, c.expected.load);
    if (c.expected.appointments) assert.deepEqual(o.appointments, c.expected.appointments);
    if (c.expected.reason) assert.equal(o.reason, c.expected.reason);
    if (c.expected.attempts) assert.deepEqual(o.attempts, c.expected.attempts);
    for (const n of c.expected.notify ?? []) assert.ok(o.notify.includes(n), `notify ${n}`);
    for (const f of c.expected.flags ?? []) assert.ok(o.flags.includes(f), `flag ${f}`);
  });
}
