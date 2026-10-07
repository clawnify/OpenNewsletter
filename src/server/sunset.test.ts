// The sunset rules against a real SQLite: who counts as inactive, who an ask
// goes to, who is removed and when, and who the keep link may bring back.
// Every rule errs toward keeping a reader; each test pins one of those.
import { beforeEach, describe, expect, it } from "vitest";
import { initDB, query, run, get } from "./db";
import { GRACE_DAYS, INACTIVE_IDS, backfillEngagement, finishSunsets, inactiveSummary, keepSubscribed, markTrackingOn } from "./sunset";
import { beginSend } from "./sending";
import { applyDeliveryEvent } from "./events";
import { markUnsubscribed } from "./contacts";
import { renderEmailHtml } from "./render";
import { DEFAULT_DESIGN } from "../shared/design";
import type { Mail, Settings } from "../shared/types";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

let db: any;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
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
});

const DAY = 24 * 3600_000;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const sqliteAgo = (days: number) => ago(days).replace("T", " ").slice(0, 19);

let mailSeq = 0;
/** A sent issue, delivered to these contacts at `days` ago, with optional opens/clicks. */
async function issue(days: number, to: string[], opts: { clicked?: string[]; opened?: string[]; segment?: string } = {}) {
  const id = ++mailSeq;
  await run(`INSERT INTO mails (id, title, audience_id, status, sent_at, segment) VALUES (?, ?, 'aud', 'sent', ?, ?)`, [
    id,
    `Issue ${id}`,
    ago(days),
    opts.segment ?? null,
  ]);
  for (const c of to) {
    await run(
      `INSERT INTO deliveries (id, mail_id, contact_id, email, batch, status, sent_at, opened_at, clicked_at)
       VALUES (?, ?, ?, ?, 0, 'sent', ?, ?, ?)`,
      [`d${id}_${c}`, id, c, `${c}@x.test`, ago(days), opts.opened?.includes(c) ? ago(days) : null, opts.clicked?.includes(c) ? ago(days) : null],
    );
  }
  return id;
}

async function contact(id: string, opts: { joinedDaysAgo?: number; status?: string; consentDaysAgo?: number } = {}) {
  await run(
    `INSERT INTO contacts (id, audience_id, email, status, consent_at, created_at) VALUES (?, 'aud', ?, ?, ?, ?)`,
    [id, `${id}@x.test`, opts.status ?? "subscribed", opts.consentDaysAgo != null ? ago(opts.consentDaysAgo) : null, sqliteAgo(opts.joinedDaysAgo ?? 400)],
  );
}

async function inactiveIds(days = 90): Promise<string[]> {
  const s = await get<{ tracking_since: string | null }>(`SELECT tracking_since FROM settings WHERE id = 1`);
  const rows = await query<{ id: string }>(INACTIVE_IDS, [s?.tracking_since ?? null, "aud", ago(days), 5]);
  return rows.map((r) => r.id).sort();
}

const status = async (id: string) => (await get<{ status: string; unsubscribe_reason: string | null }>(`SELECT status, unsubscribe_reason FROM contacts WHERE id = ?`, [id]))!;

beforeEach(async () => {
  mailSeq = 0;
  await run(`INSERT INTO audiences (id, name) VALUES ('aud', 'Subscribers')`);
  await run(`INSERT INTO settings (id) VALUES (1)`);
  await markTrackingOn(NOW - 365 * DAY);
});

describe("who is inactive", () => {
  beforeEach(async () => {
    for (const c of ["quiet", "reader", "opener", "few", "fresh", "pending"]) {
      await contact(c, c === "fresh" ? { joinedDaysAgo: 30 } : c === "pending" ? { status: "pending" } : {});
    }
    // Six issues over the last 200 days to everyone; "few" got only four.
    for (const d of [200, 170, 140, 110, 95, 92]) {
      const to = ["quiet", "reader", "opener", "fresh", "pending"].concat(d >= 110 ? ["few"] : []);
      await issue(d, to);
    }
    await issue(20, ["reader"], { clicked: ["reader"] });
    await issue(15, ["opener"], { opened: ["opener"] });
    // These opens and clicks predate last_engaged_at, as on an upgraded install.
    await backfillEngagement();
  });

  it("without the upgrade backfill, past readers would look inactive", async () => {
    await run(`UPDATE contacts SET last_engaged_at = NULL`);
    expect(await inactiveIds()).toEqual(["opener", "quiet", "reader"]);
  });

  it("is quiet for the window AND sent 5 issues since; opens count, new and pending people don't", async () => {
    expect(await inactiveIds()).toEqual(["quiet"]);
  });

  it("starts the window when tracking was turned on, not before", async () => {
    await run(`UPDATE settings SET tracking_since = ?`, [ago(30)]);
    expect(await inactiveIds()).toEqual([]);
  });

  it("finds nobody while tracking was never turned on", async () => {
    await run(`UPDATE settings SET tracking_since = NULL`);
    expect(await inactiveIds()).toEqual([]);
  });

  it("re-confirming restarts the clock", async () => {
    await run(`UPDATE contacts SET consent_at = ? WHERE id = 'quiet'`, [ago(10)]);
    expect(await inactiveIds()).toEqual([]);
  });

  it("an open of a flow email (no delivery row) counts, by address", async () => {
    expect(await applyDeliveryEvent({ kind: "opened", deliveryId: null, messageId: "flow-1", at: ago(2), to: "quiet@x.test" })).toBe(
      "engaged-no-delivery",
    );
    expect(await inactiveIds()).toEqual([]);
  });

  it("an open recorded on a delivery row counts", async () => {
    await applyDeliveryEvent({ kind: "opened", deliveryId: "d1_quiet", messageId: "m", at: ago(1), to: null });
    expect(await inactiveIds()).toEqual([]);
  });
});

describe("asking and letting go", () => {
  beforeEach(async () => {
    for (const c of ["a", "b", "c"]) await contact(c);
    for (const d of [200, 170, 140, 110, 95]) await issue(d, ["a", "b", "c"]);
  });

  it("an ask goes only to the inactive, and they aren't counted again while it runs", async () => {
    await run(`UPDATE contacts SET last_engaged_at = ? WHERE id = 'c'`, [ago(5)]);
    await run(`INSERT INTO mails (id, title, audience_id, status, segment, segment_days) VALUES (99, 'Still want us?', 'aud', 'draft', 'inactive', 90)`);
    const snap = { mail: { id: 99, title: "x", segment: "inactive" } as any, design: DEFAULT_DESIGN, settings: {} as Settings, from: "a@x.test", origin: "https://n.test" };
    expect((await beginSend(99, "aud", snap)).ok).toBe(true);
    const to = await query<{ contact_id: string }>(`SELECT contact_id FROM deliveries WHERE mail_id = 99 ORDER BY contact_id`);
    expect(to.map((r) => r.contact_id)).toEqual(["a", "b"]);
    expect(await inactiveIds()).toEqual([]);
  });

  it("removes the silent after the grace period, keeps whoever answered, and only once their copy was sent", async () => {
    const ask = await issue(GRACE_DAYS + 1, ["a", "b"], { segment: "inactive" });
    await run(`UPDATE deliveries SET status = 'failed' WHERE id = ?`, [`d${ask}_b`]);
    await issue(GRACE_DAYS + 1, ["c"]); // an ordinary issue: never removes anyone
    expect(await finishSunsets(NOW)).toBe(1);
    expect(await status("a")).toEqual({ status: "unsubscribed", unsubscribe_reason: "inactive" });
    expect((await status("b")).status).toBe("subscribed");
    expect((await status("c")).status).toBe("subscribed");
    expect((await get<{ sunset_done_at: string | null }>(`SELECT sunset_done_at FROM mails WHERE id = ?`, [ask]))?.sunset_done_at).not.toBeNull();
    expect(await finishSunsets(NOW)).toBe(0);
  });

  it("waits out the grace period", async () => {
    await issue(GRACE_DAYS - 1, ["a"], { segment: "inactive" });
    expect(await finishSunsets(NOW)).toBe(0);
    expect((await status("a")).status).toBe("subscribed");
  });

  it("keeps someone who opened, clicked or pressed keep after the ask", async () => {
    const ask = await issue(GRACE_DAYS + 2, ["a", "b"], { segment: "inactive" });
    await applyDeliveryEvent({ kind: "clicked", deliveryId: `d${ask}_a`, messageId: "m", at: ago(GRACE_DAYS), to: null });
    await keepSubscribed("b", NOW - GRACE_DAYS * DAY);
    expect(await finishSunsets(NOW)).toBe(0);
  });

  it("the keep link brings back someone the sunset removed, never someone who chose to leave", async () => {
    await issue(GRACE_DAYS + 1, ["a", "b"], { segment: "inactive" });
    await finishSunsets(NOW);
    await markUnsubscribed("aud", "b@x.test"); // b pressed unsubscribe after being removed
    expect(await status("b")).toEqual({ status: "unsubscribed", unsubscribe_reason: null });

    expect(await keepSubscribed("a", NOW)).toEqual({ email: "a@x.test" });
    expect(await status("a")).toEqual({ status: "subscribed", unsubscribe_reason: null });
    expect(await keepSubscribed("b", NOW)).toBeNull();
    expect((await status("b")).status).toBe("unsubscribed");
    // Kept after removal: not removed again by the same ask.
    await run(`UPDATE mails SET sunset_done_at = NULL`);
    expect(await finishSunsets(NOW + 1000)).toBe(0);
  });

  it("a complaint replaces a sunset removal too", async () => {
    await issue(GRACE_DAYS + 1, ["a"], { segment: "inactive" });
    await finishSunsets(NOW);
    await applyDeliveryEvent({ kind: "complained", deliveryId: null, messageId: "m", at: ago(0), to: "a@x.test" });
    expect(await keepSubscribed("a", NOW)).toBeNull();
  });
});

describe("summary and guards", () => {
  it("refuses with no tracking, and with no open or click recorded in the window", async () => {
    await contact("a");
    expect((await inactiveSummary("aud", false, 90, NOW)).blocked).toMatch(/delivery tracking/);
    await issue(10, ["a"]);
    expect((await inactiveSummary("aud", true, 90, NOW)).blocked).toMatch(/No open or click/);
    await issue(5, ["a"], { clicked: ["a"] });
    expect((await inactiveSummary("aud", true, 90, NOW)).blocked).toBeNull();
  });

  it("backfills when tracking started from the first delivered event", async () => {
    await run(`UPDATE settings SET tracking_since = NULL`);
    await contact("a");
    const m = await issue(40, ["a"]);
    await run(`UPDATE deliveries SET delivered_at = ? WHERE mail_id = ?`, [ago(40), m]);
    await inactiveSummary("aud", true, 90, NOW);
    expect((await get<{ tracking_since: string }>(`SELECT tracking_since FROM settings`))?.tracking_since).toBe(ago(40));
  });

  it("uses indexes, not a scan of every delivery", async () => {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${INACTIVE_IDS}`)
      .all(ago(365), "aud", ago(90), 5)
      .map((r: any) => r.detail)
      .join("\n");
    expect(plan).not.toMatch(/SCAN d\b|SCAN deliveries/);
    expect(plan).toMatch(/idx_deliveries_contact/);
  });
});

describe("the ask email", () => {
  const settings = { publication_name: "The Weekly", footer_text: "" } as Settings;
  const mail = { id: 1, title: "Still?", blocks: [], preheader: "" } as unknown as Mail;

  it("always carries the subscriber's keep link; an ordinary issue doesn't", () => {
    const ask = renderEmailHtml({ ...mail, segment: "inactive" }, DEFAULT_DESIGN, settings, { keepUrl: "https://n.test/api/keep?c=con_1" });
    expect(ask).toContain(`href="https://n.test/api/keep?c=con_1"`);
    expect(ask).toContain("Yes, keep me subscribed");
    expect(renderEmailHtml(mail, DEFAULT_DESIGN, settings, { keepUrl: "https://n.test/api/keep?c=con_1" })).not.toContain("keep me subscribed");
  });
});
