import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReply, newText, plainText, skipReason, threadKeys } from "../src/email";

test("threadKeys: In-Reply-To first, then References newest first, no repeats", () => {
  assert.deepEqual(threadKeys("<b@x>", "<a@x> <b@x>"), ["<b@x>", "<a@x>"]);
  assert.deepEqual(threadKeys(null, null), []);
});

test("newText drops the quoted thread", () => {
  const t = "Tuesday works.\n\nThanks, Ken\n\nOn Mon, Dec 7, 2026 at 9:00 AM Lanternfly <appointments@pranavgudise.dev> wrote:\n> Booked for 7 AM.";
  assert.equal(newText(t), "Tuesday works.\n\nThanks, Ken");
  assert.equal(newText("Yes\r\n> old\r\nok"), "Yes\nok");
  assert.equal(newText("Sure\n-----Original Message-----\nFrom: a"), "Sure");
});

test("skipReason stops loops and bulk mail", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
  assert.equal(skipReason("ken@example.com", h({}), "appointments@pranavgudise.dev"), null);
  assert.match(skipReason("ken@example.com", h({ "auto-submitted": "auto-replied" }), "a@b")!, /auto/);
  assert.match(skipReason("MAILER-DAEMON@example.com", h({}), "a@b")!, /automated/);
  assert.match(skipReason("appointments@pranavgudise.dev", h({}), "appointments@pranavgudise.dev")!, /own/);
});

test("buildReply threads the reply and encodes the body", () => {
  const raw = buildReply({
    from: "appointments@pranavgudise.dev", fromName: "Lanternfly appointment desk", to: "ken@example.com",
    subject: "PO-50132 Dayton", inReplyTo: "<m2@example.com>", references: ["<m1@example.com>"],
    messageId: "<r@pranavgudise.dev>", date: new Date("2026-12-07T14:00:00Z"), body: "Booked for 7 AM — conf DAY-DC-1",
  });
  assert.match(raw, /^Subject: Re: PO-50132 Dayton\r$/m);
  assert.match(raw, /^In-Reply-To: <m2@example.com>\r$/m);
  assert.match(raw, /^References: <m1@example.com> <m2@example.com>\r$/m);
  const b64 = raw.split("\r\n\r\n")[1].replace(/\s/g, "");
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "Booked for 7 AM — conf DAY-DC-1");
});

test("plainText strips markdown the agent may write", () => {
  assert.equal(plainText("- **Appointment:** Wed 12/9, 07:00\n## Next\nUse `DAY-DC`, *please*."), "- Appointment: Wed 12/9, 07:00\nNext\nUse DAY-DC, please.");
  assert.equal(plainText("2 * 3 = 6"), "2 * 3 = 6");
});
