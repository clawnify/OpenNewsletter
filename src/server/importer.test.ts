// Subscriber import against real SQLite: consent never moves backwards, opt-outs
// from the old platform always win, and large chunks fit one statement.
import { beforeEach, describe, expect, it } from "vitest";
import { initDB, get, query, run } from "./db";
import { addContact } from "./contacts";
import { cleanRows, importChunk, exportPage, IMPORT_CHUNK } from "./importer";
import type { ImportRow } from "../shared/import-map";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

const AUD = "aud_1";
const NOW = "2026-10-02T12:00:00.000Z";
const EVIDENCE = "Subscribed through the signup form on our old Mailchimp list";

beforeEach(async () => {
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
  await run(`INSERT INTO audiences (id, name) VALUES (?, 'List')`, [AUD]);
});

const row = (email: string, status: ImportRow["status"], extra: Partial<ImportRow> = {}): ImportRow => ({
  email, first_name: "", last_name: "", status, opted_in_at: null, ...extra,
});
const byEmail = (email: string) => get(`SELECT * FROM contacts WHERE email = ?`, [email]) as Promise<any>;

async function importRows(rows: ImportRow[], evidence = EVIDENCE) {
  const clean = cleanRows(rows, evidence, "Mailchimp export");
  return { ...(await importChunk(AUD, clean.rows, NOW)), rejected: clean.rejected };
}

describe("import into an empty list", () => {
  it("keeps each status, the original opt-in date and the consent statement", async () => {
    const r = await importRows([
      row("A@Example.com", "subscribed", { first_name: "Ann", opted_in_at: "2023-04-01 10:00:00" }),
      row("u@example.com", "unsubscribed"),
      row("b@example.com", "bounced"),
      row("p@example.com", "pending"),
    ]);
    expect(r.added).toEqual({ subscribed: 1, pending: 1, unsubscribed: 1, bounced: 1 });
    expect(await byEmail("a@example.com")).toMatchObject({
      status: "subscribed", first_name: "Ann", consent_source: "import",
      consent_at: new Date("2023-04-01 10:00:00").toISOString(),
      consent_evidence: `${EVIDENCE} (Mailchimp export)`,
    });
    expect(await byEmail("u@example.com")).toMatchObject({ status: "unsubscribed", unsubscribed_at: NOW });
  });

  it("lands subscribed rows pending when nobody says how they agreed", async () => {
    const r = await importRows([row("a@example.com", "subscribed")], "  ");
    expect(r.added.pending).toBe(1);
    expect(await byEmail("a@example.com")).toMatchObject({ status: "pending", consent_evidence: "", consent_at: null });
  });

  it("refuses bad addresses and in-file duplicates, and says why", async () => {
    const r = await importRows([row("nope", "subscribed"), row("x@example.com", "subscribed"), row("X@example.com ", "unsubscribed")]);
    expect(r.added.subscribed).toBe(1);
    expect(r.rejected).toEqual([
      { email: "nope", reason: "not an email address" },
      { email: "x@example.com", reason: "appears twice in the file" },
    ]);
  });

  it("writes a full chunk in one go", async () => {
    const rows = Array.from({ length: IMPORT_CHUNK }, (_, i) => row(`p${i}@example.com`, "subscribed"));
    const r = await importRows(rows);
    expect(r.added.subscribed).toBe(IMPORT_CHUNK);
    expect(await get(`SELECT COUNT(*) AS n FROM contacts`)).toMatchObject({ n: IMPORT_CHUNK });
  });
});

describe("import onto people already here", () => {
  it("lets an opt-out from the old platform win, and never brings back an opt-out here", async () => {
    await addContact(AUD, { email: "sub@example.com" }, { source: "signup_form", status: "subscribed", evidence: "form" });
    await addContact(AUD, { email: "gone@example.com" });
    await run(`UPDATE contacts SET status = 'unsubscribed' WHERE email = 'gone@example.com'`);

    const r = await importRows([row("sub@example.com", "unsubscribed"), row("gone@example.com", "subscribed")]);
    expect(r).toMatchObject({ suppressed: 1, unchanged: 1, confirmed: 0 });
    expect(await byEmail("sub@example.com")).toMatchObject({ status: "unsubscribed", unsubscribed_at: NOW });
    expect(await byEmail("gone@example.com")).toMatchObject({ status: "unsubscribed" });
  });

  it("confirms someone pending with the import's consent, keeps a subscriber's first record, and fills only empty names", async () => {
    await addContact(AUD, { email: "pend@example.com" });
    await addContact(AUD, { email: "sub@example.com", first_name: "Kept" }, { source: "signup_form", status: "subscribed", evidence: "form" });
    const before = await byEmail("sub@example.com");

    const r = await importRows([
      row("pend@example.com", "subscribed", { first_name: "Pat", opted_in_at: "2024-01-02T00:00:00Z" }),
      row("sub@example.com", "subscribed", { first_name: "Other", last_name: "Last" }),
    ]);
    expect(r).toMatchObject({ confirmed: 1, unchanged: 1 });
    expect(await byEmail("pend@example.com")).toMatchObject({
      status: "subscribed", first_name: "Pat", consent_source: "import", consent_at: "2024-01-02T00:00:00.000Z",
    });
    expect(await byEmail("sub@example.com")).toMatchObject({
      status: "subscribed", consent_source: before.consent_source, consent_evidence: before.consent_evidence,
      first_name: "Kept", last_name: "Last",
    });
  });
});

describe("export", () => {
  it("pages every contact once in a stable order, whatever the status", async () => {
    await importRows([row("a@example.com", "subscribed"), row("b@example.com", "unsubscribed"), row("c@example.com", "pending")]);
    const first = await exportPage(AUD, "", 2);
    const rest = await exportPage(AUD, String(first[1].id), 2);
    expect([...first, ...rest].map((r) => r.email).sort()).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(rest).toHaveLength(1);
    expect((await query(`SELECT 1 FROM contacts`)).length).toBe(3);
  });
});
