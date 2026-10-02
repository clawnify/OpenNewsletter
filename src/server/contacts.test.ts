// Double opt-in against real SQLite: what a repeat signup sends, when a link
// expires, who is owed a confirmation email, and the per-caller limit.
import { beforeEach, describe, expect, it } from "vitest";
import { initDB, get, run } from "./db";
import {
  CONFIRM_COOLDOWN_MS,
  CONFIRM_TTL_MS,
  MAX_CONFIRM_EMAILS,
  REMIND_AFTER_MS,
  SIGNUPS_PER_IP_PER_HOUR,
  addContact,
  allowSignup,
  confirmSignup,
  confirmationsDue,
  listAudiences,
  peekConfirmation,
  recordConfirmation,
  startSignup,
} from "./contacts";

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

const AUD = "aud_1";
const T0 = Date.parse("2026-09-30T10:00:00Z");

beforeEach(async () => {
  useSqlite();
  await run(`INSERT INTO audiences (id, name) VALUES (?, 'List')`, [AUD]);
});

async function signup(email: string, at: number) {
  const r = await startSignup(AUD, { email }, at);
  if ("alreadySubscribed" in r) throw new Error("unexpected");
  if (r.send) await recordConfirmation(r.contact.id, {}, at);
  return r;
}

describe("startSignup", () => {
  it("sends once, then stays quiet inside the cooldown, reusing the same link", async () => {
    const a = await signup("x@example.com", T0);
    expect(a.send).toBe(true);
    const b = await signup("x@example.com", T0 + CONFIRM_COOLDOWN_MS - 1);
    expect(b).toMatchObject({ send: false, token: a.token });
    const c = await signup("x@example.com", T0 + CONFIRM_COOLDOWN_MS + 1);
    expect(c).toMatchObject({ send: true, token: a.token }); // earlier emails keep working
  });

  it("issues a fresh link once the old one has expired, and never touches a subscriber", async () => {
    const a = await signup("x@example.com", T0);
    const b = await signup("x@example.com", T0 + CONFIRM_TTL_MS + 1);
    expect(b.token).not.toBe(a.token);
    expect(await confirmSignup(b.token, "click", T0 + CONFIRM_TTL_MS + 2)).toMatchObject({ status: "subscribed" });
    expect(await startSignup(AUD, { email: "x@example.com" })).toEqual({ alreadySubscribed: true });
  });
});

describe("confirmation links", () => {
  it("can be looked at without being used, then used exactly once", async () => {
    const a = await signup("x@example.com", T0);
    expect(await peekConfirmation(a.token, T0 + 1000)).toMatchObject({ contact: { email: "x@example.com", status: "pending" } });
    expect(await peekConfirmation(a.token, T0 + 1000)).toMatchObject({ contact: { status: "pending" } }); // looking twice changes nothing
    expect(await confirmSignup(a.token, "click", T0 + 2000)).toMatchObject({ status: "subscribed" });
    expect(await confirmSignup(a.token, "click", T0 + 3000)).toBeNull();
  });

  it("stop working 7 days after their email", async () => {
    const a = await signup("x@example.com", T0);
    expect(await peekConfirmation(a.token, T0 + CONFIRM_TTL_MS)).toEqual({ expired: true });
    expect(await confirmSignup(a.token, "click", T0 + CONFIRM_TTL_MS)).toBeNull();
    expect((await get<{ status: string }>(`SELECT status FROM contacts WHERE email = 'x@example.com'`))!.status).toBe("pending");
  });
});

describe("confirmationsDue", () => {
  it("covers people who never got an email and people owed a reminder, up to the cap", async () => {
    await addContact(AUD, { email: "manual@example.com" }); // added by hand: never emailed
    const failed = await startSignup(AUD, { email: "failed@example.com" }, T0);
    if ("alreadySubscribed" in failed) throw new Error();
    await recordConfirmation(failed.contact.id, { error: "Resend 403" }, T0); // the send failed
    await signup("fresh@example.com", T0); // emailed just now: not due
    await signup("old@example.com", T0 - REMIND_AFTER_MS - 1); // emailed over a day ago: owed a reminder

    const due = await confirmationsDue(AUD, 100, T0);
    expect(due.map((d) => d.email).sort()).toEqual(["failed@example.com", "manual@example.com", "old@example.com"]);
    expect(due.every((d) => d.token.length > 0)).toBe(true);

    const [aud] = await listAudiences(T0);
    expect(aud).toMatchObject({ pending_count: 4, pending_unsent: 2, pending_due: 1 });
  });

  it("stops reminding after the third email", async () => {
    const r = await startSignup(AUD, { email: "x@example.com" }, T0);
    if ("alreadySubscribed" in r) throw new Error();
    let t = T0;
    for (let i = 0; i < MAX_CONFIRM_EMAILS; i++) {
      await recordConfirmation(r.contact.id, {}, t);
      t += REMIND_AFTER_MS + 1;
    }
    expect(await confirmationsDue(AUD, 100, t)).toEqual([]);
  });

  it("replaces an expired link before a reminder carries it", async () => {
    const a = await signup("x@example.com", T0);
    const [due] = await confirmationsDue(AUD, 100, T0 + CONFIRM_TTL_MS + 1);
    expect(due.token).not.toBe(a.token);
  });
});

describe("allowSignup", () => {
  it("allows a burst from one network up to the limit, then refuses until the hour has passed", async () => {
    for (let i = 0; i < SIGNUPS_PER_IP_PER_HOUR; i++) expect(await allowSignup("203.0.113.9", T0 + i)).toBe(true);
    expect(await allowSignup("203.0.113.9", T0 + 100)).toBe(false);
    expect(await allowSignup("198.51.100.1", T0 + 100)).toBe(true);
    expect(await allowSignup("203.0.113.9", T0 + 3600_000 + 100)).toBe(true);
    const stored = await get<{ ip_hash: string }>(`SELECT ip_hash FROM signup_attempts LIMIT 1`);
    expect(stored!.ip_hash).not.toContain("203.0.113");
  });
});

describe("addContact on an address already in the list", () => {
  it("never downgrades a subscriber or replaces their consent record", async () => {
    const s = await signup("sub@example.com", T0);
    await confirmSignup(s.token, "click", T0 + 1);
    const before = (await get(`SELECT * FROM contacts WHERE email = ?`, ["sub@example.com"])) as any;

    // Added again by hand (no evidence), then again with a CRM consent note.
    await addContact(AUD, { email: "Sub@Example.com", first_name: "Ann" });
    await addContact(AUD, { email: "sub@example.com", crm_contact_id: "crm_9" }, {
      source: "crm_sync",
      status: "subscribed",
      evidence: "Opted in at a webinar",
    });

    const after = (await get(`SELECT * FROM contacts WHERE email = ?`, ["sub@example.com"])) as any;
    expect(after).toMatchObject({
      status: "subscribed",
      consent_source: before.consent_source,
      consent_at: before.consent_at,
      consent_evidence: before.consent_evidence,
      first_name: "Ann",
      crm_contact_id: "crm_9",
    });
  });

  it("upgrades pending to subscribed only when consent is given, and keeps a pending signup's source otherwise", async () => {
    await signup("p@example.com", T0);
    await addContact(AUD, { email: "p@example.com" });
    expect(await get(`SELECT status, consent_source FROM contacts WHERE email = ?`, ["p@example.com"]))
      .toMatchObject({ status: "pending", consent_source: "signup_form" });

    await addContact(AUD, { email: "p@example.com" }, { source: "import", status: "subscribed", evidence: "Mailchimp export, opted in 2024" });
    const row = (await get(`SELECT * FROM contacts WHERE email = ?`, ["p@example.com"])) as any;
    expect(row).toMatchObject({ status: "subscribed", consent_source: "import", consent_evidence: "Mailchimp export, opted in 2024" });
    expect(row.consent_at).toBeTruthy();
  });
});
