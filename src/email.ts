// Email helpers for the inbound address: which conversation a message belongs to, the new text in a
// reply (without the quoted thread), loop protection, and the raw MIME reply. Pure functions, unit tested.

/** Message-IDs this email points back to, newest first: In-Reply-To, then References from the end. */
export function threadKeys(inReplyTo: string | null | undefined, references: string | null | undefined): string[] {
  const ids = (s: string | null | undefined) => (s ?? "").match(/<[^<>\s]+>/g) ?? [];
  const out: string[] = [];
  for (const id of [...ids(inReplyTo), ...ids(references).reverse()]) if (!out.includes(id)) out.push(id);
  return out;
}

/** The new part of a reply: drops the quoted thread ("On ... wrote:", "-----Original Message-----", "> " lines). */
export function newText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim())) break;
    if (/^On .+wrote:\s*$/.test(l.trim()) || (/^On /.test(l.trim()) && /wrote:\s*$/.test(`${l} ${lines[i + 1] ?? ""}`.trim()))) break;
    if (/^From: .+/.test(l) && /^(Sent|Date): /.test(lines[i + 1] ?? "")) break;
    if (l.startsWith(">")) continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

/** Why not to answer this email automatically, or null when it is fine to answer. */
export function skipReason(from: string, headers: { get(name: string): string | null }, self: string): string | null {
  const f = from.toLowerCase();
  if (f === self.toLowerCase()) return "from our own address";
  if (/^(mailer-daemon|postmaster|no-?reply|donotreply)@/.test(f)) return "automated sender";
  const auto = (headers.get("auto-submitted") ?? "no").toLowerCase();
  if (auto !== "no") return `auto-submitted: ${auto}`;
  if (headers.get("list-id") || /bulk|list|junk/i.test(headers.get("precedence") ?? "")) return "mailing list or bulk mail";
  return null;
}

const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);

/** Base64 body lines of at most 76 characters. */
function base64Body(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return (btoa(bin).match(/.{1,76}/g) ?? []).join("\r\n");
}

export type ReplyParts = {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  inReplyTo: string;
  references: string[];
  messageId: string;
  date: Date;
  body: string;
};

/** A plain-text reply as raw MIME, threaded with In-Reply-To and References. */
export function buildReply(p: ReplyParts): string {
  const subject = /^re:/i.test(p.subject.trim()) ? p.subject.trim() : `Re: ${p.subject.trim() || "your appointment request"}`;
  const refs = [...p.references.filter((r) => r !== p.inReplyTo), p.inReplyTo].slice(-20);
  return [
    `From: ${encodeHeader(p.fromName)} <${p.from}>`,
    `To: <${p.to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${p.date.toUTCString()}`,
    `Message-ID: ${p.messageId}`,
    `In-Reply-To: ${p.inReplyTo}`,
    `References: ${refs.join(" ")}`,
    "Auto-Submitted: auto-replied",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(p.body),
    "",
  ].join("\r\n");
}

/** Email clients show markdown literally, so drop bold, italics, headings and code ticks from the agent's reply. */
export function plainText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[\s(])\*(\S[^*\n]*?)\*(?=[\s).,;:!?]|$)/gm, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`\n]+)`/g, "$1");
}
