// Delivery events: the Svix signature check, the Resend payload reduction, and
// what each event does to delivery rows and people, against real SQLite.
import { beforeEach, describe, expect, it } from "vitest";
import { initDB, query, run } from "./db";
import { applyDeliveryEvent } from "./events";
import { DELIVERY_TAG, parseResendEvent, verifyResendWebhook } from "./providers/resend-webhook";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

function useSqlite() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  initDB({
    STORAGE: {
      async query(sql: string, params: unknown[] = []) {
        const stmt = db.prepare(sql);
        if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: stmt.all(...(params as any[])) };
        stmt.run(...(params as any[]));
        return { rows: [] };
      },
    },
  });
}

// Svix's documented example secret; the signature is computed here the way
// Svix does, so the check is tested against the spec, not against itself.
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
async function sign(id: string, ts: string, body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.slice(6)), (ch) => ch.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

describe("verifyResendWebhook", () => {
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
  const now = 1_700_000_000;

  it("accepts a correct signature, including one of several listed", async () => {
    const sig = await sign("msg_1", String(now), body);
    expect(await verifyResendWebhook(body, { id: "msg_1", timestamp: String(now), signature: sig }, SECRET, now)).toBe(true);
    expect(await verifyResendWebhook(body, { id: "msg_1", timestamp: String(now), signature: `v1,bogus= ${sig}` }, SECRET, now)).toBe(true);
  });

  it("refuses a changed body, another secret, a stale timestamp, or missing headers", async () => {
    const sig = await sign("msg_1", String(now), body);
    const h = { id: "msg_1", timestamp: String(now), signature: sig };
    expect(await verifyResendWebhook(body + " ", h, SECRET, now)).toBe(false);
    expect(await verifyResendWebhook(body, h, "whsec_" + btoa("another secret key"), now)).toBe(false);
    expect(await verifyResendWebhook(body, h, SECRET, now + 301)).toBe(false);
    expect(await verifyResendWebhook(body, { ...h, id: null }, SECRET, now)).toBe(false);
    expect(await verifyResendWebhook(body, { ...h, signature: sig.replace("v1,", "v2,") }, SECRET, now)).toBe(false);
  });
});

describe("parseResendEvent", () => {
  it("reads the delivery tag and the bounce type", () => {
    const ev = parseResendEvent({
      type: "email.bounced",
      created_at: "2026-09-30T10:00:00Z",
      data: { email_id: "e1", tags: { [DELIVERY_TAG]: "dlv_1" }, bounce: { type: "Permanent", message: "mailbox unavailable" } },
    });
    expect(ev).toEqual({ kind: "bounced", deliveryId: "dlv_1", messageId: "e1", at: "2026-09-30T10:00:00Z", permanent: true, reason: "mailbox unavailable" });
  });

  it("treats an unrecognised bounce type as temporary, and ignores events it doesn't act on", () => {
    expect(parseResendEvent({ type: "email.bounced", data: { email_id: "e1", bounce: { type: "Undetermined" } } })).toMatchObject({ permanent: false });
    expect(parseResendEvent({ type: "email.sent", data: { email_id: "e1" } })).toBeNull();
    expect(parseResendEvent({ type: "email.delivered", data: {} })).toBeNull();
  });
});

describe("applyDeliveryEvent", () => {
  beforeEach(async () => {
    useSqlite();
    await run(`INSERT INTO audiences (id, name) VALUES ('a1', 'One'), ('a2', 'Two')`);
    await run(
      `INSERT INTO contacts (id, audience_id, email, status) VALUES
        ('c1', 'a1', 'x@example.com', 'subscribed'), ('c2', 'a2', 'x@example.com', 'subscribed'),
        ('c3', 'a1', 'y@example.com', 'subscribed')`,
    );
    await run(
      `INSERT INTO deliveries (id, mail_id, contact_id, email, batch, status, provider_message_id) VALUES
        ('d1', 1, 'c1', 'x@example.com', 0, 'sent', 'e1'), ('d3', 1, 'c3', 'y@example.com', 0, 'sent', 'e3')`,
    );
  });
  const at = "2026-09-30T10:00:00Z";
  const statuses = async () =>
    Object.fromEntries((await query<{ id: string; status: string }>(`SELECT id, status FROM contacts ORDER BY id`)).map((r) => [r.id, r.status]));

  it("stops mailing a hard-bounced address on every list, but not a soft-bounced one", async () => {
    await applyDeliveryEvent({ kind: "bounced", deliveryId: "d3", messageId: "e3", at, permanent: false, reason: "mailbox full" });
    expect((await statuses()).c3).toBe("subscribed");
    await applyDeliveryEvent({ kind: "bounced", deliveryId: "d1", messageId: "e1", at, permanent: true, reason: "no such user" });
    expect(await statuses()).toEqual({ c1: "bounced", c2: "bounced", c3: "subscribed" });
  });

  it("unsubscribes a complainer from every list", async () => {
    await applyDeliveryEvent({ kind: "complained", deliveryId: "d1", messageId: "e1", at });
    expect(await statuses()).toEqual({ c1: "unsubscribed", c2: "unsubscribed", c3: "subscribed" });
  });

  it("maps by provider id when the tag is missing, keeps the first timestamp, and ignores mail it didn't send", async () => {
    await applyDeliveryEvent({ kind: "clicked", deliveryId: null, messageId: "e1", at });
    await applyDeliveryEvent({ kind: "clicked", deliveryId: "d1", messageId: "e1", at: "2026-10-01T00:00:00Z" });
    const [d] = await query<{ clicked_at: string }>(`SELECT clicked_at FROM deliveries WHERE id = 'd1'`);
    expect(d.clicked_at).toBe(at);
    expect(await applyDeliveryEvent({ kind: "delivered", deliveryId: null, messageId: "confirmation-email", at })).toBe("unknown-delivery");
  });
});
