// Findings from the adversarial review of the sunset (run 10), each proven
// failing before its fix. Kept so a later change can't bring one back.
import { beforeEach, describe, expect, it } from "vitest";
import { initDB, query, run, get } from "./db";
import { INACTIVE_IDS, finishSunsets, inactiveSummary, keepSubscribed, markTrackingOn, backfillEngagement, blockedReason } from "./sunset";
import { beginSend, drainSend } from "./sending";
import { applyDeliveryEvent } from "./events";
import { DEFAULT_DESIGN } from "../shared/design";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");
let db: any;
const DAY = 24 * 3600_000;
const NOW = Date.now();
const ago = (d: number) => new Date(NOW - d * DAY).toISOString();
const sqliteAgo = (d: number) => ago(d).replace("T", " ").slice(0, 19);

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  initDB({ STORAGE: { async query(sql: string, params: unknown[] = []) {
    const stmt = db.prepare(sql);
    if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: stmt.all(...(params as any[])) };
    stmt.run(...(params as any[])); return { rows: [] };
  } } });
  await run(`INSERT INTO audiences (id, name) VALUES ('aud', 'A'), ('aud2', 'B')`);
  await run(`INSERT INTO settings (id) VALUES (1)`);
  await markTrackingOn(NOW - 365 * DAY);
});

let seq = 0;
async function contact(id: string, aud = "aud", email = `${id}@x.test`) {
  await run(`INSERT INTO contacts (id, audience_id, email, status, created_at) VALUES (?, ?, ?, 'subscribed', ?)`, [id, aud, email, sqliteAgo(400)]);
}
async function issue(days: number, to: [string, string][], opened: string[] = [], aud = "aud", delivered = true) {
  const id = ++seq + 100;
  await run(`INSERT INTO mails (id, title, audience_id, status, sent_at) VALUES (?, 't', ?, 'sent', ?)`, [id, aud, ago(days)]);
  for (const [cid, email] of to)
    await run(`INSERT INTO deliveries (id, mail_id, contact_id, email, batch, status, sent_at, delivered_at, opened_at) VALUES (?, ?, ?, ?, 0, 'sent', ?, ?, ?)`,
      [`d${id}_${cid}`, id, cid, email, ago(days), delivered ? ago(days) : null, opened.includes(cid) ? ago(days) : null]);
}
const st = async (id: string) => (await get<any>(`SELECT status, unsubscribe_reason FROM contacts WHERE id = ?`, [id]))!;

describe("adversarial review findings, each pinned", () => {
  it("a reader who presses keep while their copy's outcome is unknown stays (engagement counts from the send's start)", async () => {
    await contact("q");
    for (const d of [200, 170, 140, 110, 95]) await issue(d, [["q", "q@x.test"]]);
    await issue(5, [], []); // some recent mail
    await run(`INSERT INTO mails (id, title, audience_id, status, segment, segment_days) VALUES (1, 'ask', 'aud', 'draft', 'inactive', 90)`);
    const snap: any = { mail: { id: 1, title: "ask", blocks: [], segment: "inactive" }, design: DEFAULT_DESIGN, settings: {}, from: "a@x.test", origin: "https://o", renderer: 2 };
    expect((await beginSend(1, "aud", snap)).ok).toBe(true);
    let t = NOW;
    let calls = 0;
    const provider: any = { name: "fake", listDomains: async () => [], sendEmail: async () => { throw 0; },
      sendBatch: async (i: any) => (++calls === 1 ? { kind: "unknown", message: "timeout" } : { kind: "sent", ids: i.messages.map(() => "m1") }) };
    await drainSend(1, provider, { now: () => t });             // provider delivered, answer lost
    const row = (await get<any>(`SELECT id FROM deliveries WHERE mail_id = 1`))!;
    t = NOW + 3 * 60_000;                                      // reader presses keep 3 min later
    await keepSubscribed("q", t);
    t = NOW + 11 * 60_000;                                     // claim stale: retried under the same key
    await drainSend(1, provider, { now: () => t });
    // Resend reports the first attempt's delivery; the row says sent only after the retry.
    await run(`UPDATE deliveries SET delivered_at = ? WHERE id = ?`, [new Date(NOW + 60_000).toISOString(), row.id]);
    const d = (await get<any>(`SELECT sent_at FROM deliveries WHERE id = ?`, [row.id]))!;
    const c = (await get<any>(`SELECT last_engaged_at FROM contacts WHERE id = 'q'`))!;
    expect(c.last_engaged_at < d.sent_at).toBe(true); // the case the review found
    await finishSunsets(t + 11 * DAY);
    expect(await st("q")).toEqual({ status: "subscribed", unsubscribe_reason: null });
  });

  it("a hard bounce replaces a sunset removal, so the keep link can't revive the address", async () => {
    await contact("q");
    await run(`UPDATE contacts SET status='unsubscribed', unsubscribe_reason='inactive' WHERE id='q'`);
    await contact("q2", "aud2", "q@x.test");
    await run(`INSERT INTO mails (id, title, audience_id, status, sent_at) VALUES (9, 't', 'aud2', 'sent', ?)`, [ago(1)]);
    await run(`INSERT INTO deliveries (id, mail_id, contact_id, email, batch, status, sent_at) VALUES ('dx', 9, 'q2', 'q@x.test', 0, 'sent', ?)`, [ago(1)]);
    await applyDeliveryEvent({ kind: "bounced", deliveryId: "dx", messageId: "m", at: ago(0), permanent: true, reason: "no such user", to: "q@x.test" });
    expect(await keepSubscribed("q")).toBeNull();
  });

  it("months of broken tracking don't make past readers inactive: only delivered copies count", async () => {
    for (const c of ["a", "b", "c"]) await contact(c);
    // Readers opened everything until 150 days ago; then the webhook broke (no events recorded).
    for (const d of [200, 180, 160]) await issue(d, [["a", "a@x.test"], ["b", "b@x.test"], ["c", "c@x.test"]], ["a", "b", "c"]);
    // The broken webhook recorded nothing for these, delivered events included.
    for (const d of [140, 120, 100, 80, 60]) await issue(d, [["a", "a@x.test"], ["b", "b@x.test"], ["c", "c@x.test"]], [], "aud", false);
    await backfillEngagement();
    // Webhook fixed yesterday: one open arrives on yesterday's issue.
    await run(`INSERT INTO contacts (id, audience_id, email, status, created_at) VALUES ('z','aud','z@x.test','subscribed',?)`, [sqliteAgo(400)]);
    await issue(1, [["z", "z@x.test"]], ["z"]);
    const sum = await inactiveSummary("aud", true, 90, NOW);
    expect(sum.inactive).toBe(0);
  });

  it("the backfill is per address, like live engagement", async () => {
    await contact("onA", "aud", "p@x.test");
    await contact("onB", "aud2", "p@x.test");
    await issue(10, [["onA", "p@x.test"]], ["onA"]);
    await backfillEngagement();
    expect((await get<any>(`SELECT last_engaged_at FROM contacts WHERE id='onA'`))!.last_engaged_at).not.toBeNull();
    expect((await get<any>(`SELECT last_engaged_at FROM contacts WHERE id='onB'`))!.last_engaged_at).not.toBeNull();
  });

  it("an ask that soft-bounced never removes the reader", async () => {
    await contact("q");
    await run(`INSERT INTO mails (id, title, audience_id, status, segment, sent_at) VALUES (1, 'ask', 'aud', 'sent', 'inactive', ?)`, [ago(12)]);
    await run(`INSERT INTO deliveries (id, mail_id, contact_id, email, batch, status, sent_at) VALUES ('da', 1, 'q', 'q@x.test', 0, 'sent', ?)`, [ago(12)]);
    await applyDeliveryEvent({ kind: "bounced", deliveryId: "da", messageId: "m", at: ago(12), permanent: false, reason: "mailbox full", to: "q@x.test" });
    await finishSunsets(NOW);
    expect(await st("q")).toEqual({ status: "subscribed", unsubscribe_reason: null });
  });
});
