// The send engine against a real SQLite (node:sqlite behind @clawnify/db's
// StorageBinding) and a fake provider that deduplicates by idempotency key the
// way Resend does. What these pin down is the thing the engine exists for: no
// recipient is mailed twice, and nobody is silently dropped, whatever the
// provider answers.
import { beforeEach, describe, expect, it } from "vitest";
import { initDB, query, run, get } from "./db";
import { BATCH_SIZE, MAX_ATTEMPTS, STALE_CLAIM_MS, beginSend, drainSend, progress, type SendSnapshot } from "./sending";
import type { BatchOutcome, EmailProvider, SendBatchInput } from "./providers/types";
import { DEFAULT_DESIGN } from "../shared/design";

// Node built-ins without pulling Node's types into a Workers project.
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
        if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
          return { rows: stmt.all(...(params as any[])) };
        }
        const r = stmt.run(...(params as any[]));
        return { rows: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    },
  });
}

/** Deduplicates by key like Resend; `script` decides what each new request answers. */
class FakeProvider implements EmailProvider {
  readonly name = "fake";
  delivered: string[] = [];
  batchCalls: SendBatchInput[] = [];
  singles: string[] = [];
  script: (input: SendBatchInput, call: number) => BatchOutcome | "deliver-then-unknown" = () => ({ kind: "sent", ids: [] });
  singleFails = new Set<string>();
  /** When set, every single-send failure says this (an account-level cause, not an address). */
  singleFailMessage?: string;
  private seen = new Map<string, BatchOutcome>();

  async listDomains() { return []; }
  async sendEmail(input: { to: string; idempotencyKey?: string }) {
    if (this.singleFails.has(input.to)) throw new Error(this.singleFailMessage ?? `invalid address ${input.to}`);
    if (input.idempotencyKey && this.seen.has(input.idempotencyKey)) return { id: "dup" };
    if (input.idempotencyKey) this.seen.set(input.idempotencyKey, { kind: "sent", ids: [] });
    this.delivered.push(input.to);
    this.singles.push(input.to);
    return { id: `single-${input.to}` };
  }
  async sendBatch(input: SendBatchInput): Promise<BatchOutcome> {
    this.batchCalls.push(input);
    const prior = this.seen.get(input.idempotencyKey);
    if (prior) return prior;
    const planned = this.script(input, this.batchCalls.length);
    if (planned === "deliver-then-unknown") {
      // It landed, but the answer was lost: the retry must be deduplicated.
      const ok: BatchOutcome = { kind: "sent", ids: input.messages.map((m: { to: string }) => `id-${m.to}`) };
      this.seen.set(input.idempotencyKey, ok);
      this.delivered.push(...input.messages.map((m: { to: string }) => m.to));
      return { kind: "unknown", message: "timeout" };
    }
    if (planned.kind === "sent") {
      const ok: BatchOutcome = { kind: "sent", ids: input.messages.map((m: { to: string }) => `id-${m.to}`) };
      this.seen.set(input.idempotencyKey, ok);
      this.delivered.push(...input.messages.map((m: { to: string }) => m.to));
      return ok;
    }
    return planned;
  }
}

const AUD = "aud_test";

async function seed(subscribers: number, extra: { email: string; status: string }[] = []) {
  await run(`INSERT INTO audiences (id, name) VALUES (?, 'List')`, [AUD]);
  for (let i = 0; i < subscribers; i++) {
    await run(
      `INSERT INTO contacts (id, audience_id, email, status, created_at) VALUES (?, ?, ?, 'subscribed', ?)`,
      [`con_${String(i).padStart(4, "0")}`, AUD, `r${i}@example.com`, `2026-01-01 00:00:${String(i % 60).padStart(2, "0")}`],
    );
  }
  for (const [i, x] of extra.entries()) {
    await run(`INSERT INTO contacts (id, audience_id, email, status) VALUES (?, ?, ?, ?)`, [`con_x${i}`, AUD, x.email, x.status]);
  }
  await run(`INSERT INTO mails (id, title, audience_id, status) VALUES (1, 'Issue 1', ?, 'draft')`, [AUD]);
}

const snapshot = (): SendSnapshot => ({
  mail: {
    id: 1, eyebrow: "", title: "Issue 1", subtitle: "", byline_name: "", byline_date: "", feature_image: "",
    blocks: [], design: null, design_mobile: null, template_slug: null, audience_id: AUD, status: "draft",
    broadcast_id: null, scheduled_at: null, sent_at: null, created_at: "", updated_at: "",
  },
  design: DEFAULT_DESIGN,
  settings: { publication_name: "Pub", logo: "", from_name: "", from_email: "a@b.co", senders: [], default_audience_id: AUD, footer_text: "" },
  from: "a@b.co",
  origin: "https://pub.apps.clawnify.com",
});

const status = async () => (await get<{ status: string }>(`SELECT status FROM mails WHERE id = 1`))!.status;

describe("send engine", () => {
  let p: FakeProvider;
  beforeEach(() => {
    useSqlite();
    p = new FakeProvider();
  });

  it("sends every confirmed subscriber once, in fixed batches, each under its own key", async () => {
    await seed(250, [{ email: "pending@example.com", status: "pending" }, { email: "gone@example.com", status: "unsubscribed" }]);
    const begun = await beginSend(1, AUD, snapshot());
    expect(begun.ok).toBe(true);

    const r = await drainSend(1, p);
    expect(r).toMatchObject({ status: "sent", sent: 250, failed: 0, open: 0 });
    expect(await status()).toBe("sent");
    expect(p.delivered).toHaveLength(250);
    expect(new Set(p.delivered).size).toBe(250);
    expect(p.batchCalls.map((b) => b.messages.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 50]);
    expect(new Set(p.batchCalls.map((b) => b.idempotencyKey)).size).toBe(3);
    // Each message carries its own recipient's unsubscribe link.
    const first = p.batchCalls[0].messages[0];
    expect(first.html).toContain(first.unsubscribeUrl);
    const ids = await query<{ provider_message_id: string; email: string }>(`SELECT provider_message_id, email FROM deliveries`);
    expect(ids.every((d) => d.provider_message_id === `id-${d.email}`)).toBe(true);
  });

  it("retries a lost answer under the same key, so the batch is not mailed twice", async () => {
    await seed(120);
    await beginSend(1, AUD, snapshot());
    p.script = (_input, call) => (call === 1 ? "deliver-then-unknown" : { kind: "sent", ids: [] });

    let t = Date.parse("2026-09-30T10:00:00Z");
    const r1 = await drainSend(1, p, { now: () => t });
    expect(r1).toMatchObject({ status: "sending", sent: 20, open: 100 });

    // Not stale yet: nothing is retried.
    await drainSend(1, p, { now: () => t });
    expect(p.batchCalls).toHaveLength(2);

    t += STALE_CLAIM_MS + 1;
    const r2 = await drainSend(1, p, { now: () => t });
    expect(r2).toMatchObject({ status: "sent", sent: 120, open: 0 });
    expect(p.batchCalls[2].idempotencyKey).toBe(p.batchCalls[0].idempotencyKey);
    expect(p.delivered).toHaveLength(120);
  });

  it("records a batch that never gets an answer as failed after MAX_ATTEMPTS, saying it may have arrived", async () => {
    await seed(3);
    await beginSend(1, AUD, snapshot());
    p.script = () => ({ kind: "unknown", message: "503" });
    let t = 0;
    for (let i = 0; i <= MAX_ATTEMPTS; i++) {
      await drainSend(1, p, { now: () => t });
      t += STALE_CLAIM_MS + 1;
    }
    expect(p.batchCalls).toHaveLength(MAX_ATTEMPTS);
    const r = await progress(1);
    expect(r).toMatchObject({ status: "failed", failed: 3, sent: 0, open: 0 });
    const errs = await query<{ error: string }>(`SELECT error FROM deliveries`);
    expect(errs[0].error).toMatch(/may have been delivered/);
  });

  it("isolates one bad address instead of failing its whole batch", async () => {
    await seed(5, [{ email: "bad@", status: "subscribed" }]);
    await beginSend(1, AUD, snapshot());
    p.script = () => ({ kind: "invalid", message: "invalid `to`" });
    p.singleFails.add("bad@");
    const r = await drainSend(1, p);
    expect(r).toMatchObject({ status: "sent", sent: 5, failed: 1 });
    expect(p.singles).toHaveLength(5);
  });

  it("stops on a fatal refusal with nothing marked sent, and resumes cleanly once fixed", async () => {
    await seed(150);
    await beginSend(1, AUD, snapshot());
    p.script = () => ({ kind: "fatal", message: "Resend 403: domain not verified" });
    const r1 = await drainSend(1, p);
    expect(r1).toMatchObject({ status: "failed", sent: 0, open: 150, error: "Resend 403: domain not verified" });

    const refusedKey = p.batchCalls[0].idempotencyKey;
    p.script = () => ({ kind: "sent", ids: [] });
    const again = await beginSend(1, AUD, snapshot());
    expect(again).toMatchObject({ ok: true, resumed: true });
    const r2 = await drainSend(1, p);
    expect(r2).toMatchObject({ status: "sent", sent: 150 });
    expect(p.delivered).toHaveLength(150);
    // Nothing was sent under the refused key, so the retry must not reuse it.
    expect(p.batchCalls[1].idempotencyKey).not.toBe(refusedKey);
  });

  it("treats a batch where every single send fails the same way as a stopped send", async () => {
    await seed(4);
    await beginSend(1, AUD, snapshot());
    p.script = () => ({ kind: "invalid", message: "bad from" });
    p.singleFailMessage = "Resend 422: invalid `from`";
    for (let i = 0; i < 4; i++) p.singleFails.add(`r${i}@example.com`);
    const r = await drainSend(1, p);
    expect(r).toMatchObject({ status: "failed", open: 4, failed: 0, error: "Resend 422: invalid `from`" });
  });

  it("waits out a rate limit and retries the same batch", async () => {
    await seed(10);
    await beginSend(1, AUD, snapshot());
    p.script = (_i, call) => (call === 1 ? { kind: "rate_limited", retryAfterMs: 1000 } : { kind: "sent", ids: [] });
    const waits: number[] = [];
    const r = await drainSend(1, p, { sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([1000]);
    expect(r).toMatchObject({ status: "sent", sent: 10 });
  });

  it("hands a rate-limited batch back instead of waiting past the deadline", async () => {
    await seed(10);
    await beginSend(1, AUD, snapshot());
    p.script = () => ({ kind: "rate_limited", retryAfterMs: 5000 });
    const r = await drainSend(1, p, { deadline: 3000, now: () => 0 });
    expect(r).toMatchObject({ status: "sending", open: 10 });
    const rows = await query<{ status: string; attempts: number }>(`SELECT DISTINCT status, attempts FROM deliveries`);
    expect(rows).toEqual([{ status: "pending", attempts: 0 }]);
  });

  it("stops starting batches at the deadline and leaves the rest waiting", async () => {
    await seed(300);
    await beginSend(1, AUD, snapshot());
    let t = 0;
    p.script = () => { t += 1000; return { kind: "sent", ids: [] }; };
    const r = await drainSend(1, p, { deadline: 2000, now: () => t });
    expect(r).toMatchObject({ status: "sending", sent: 200, open: 100 });
    expect(await drainSend(1, p)).toMatchObject({ status: "sent", sent: 300 });
  });

  it("skips someone who unsubscribed after the send began, and ignores people who joined", async () => {
    await seed(3);
    await beginSend(1, AUD, snapshot());
    await run(`UPDATE contacts SET status = 'unsubscribed' WHERE email = 'r1@example.com'`);
    await run(`INSERT INTO contacts (id, audience_id, email, status) VALUES ('con_late', ?, 'late@example.com', 'subscribed')`, [AUD]);
    const r = await drainSend(1, p);
    expect(r).toMatchObject({ status: "sent", sent: 2, skipped: 1 });
    expect(p.delivered.sort()).toEqual(["r0@example.com", "r2@example.com"]);
  });

  it("resumes rather than restarts, and refuses a sent issue", async () => {
    await seed(5);
    const a = await beginSend(1, AUD, snapshot());
    const b = await beginSend(1, AUD, snapshot());
    expect(b).toEqual({ ok: true, sendId: (a as { sendId: string }).sendId, resumed: true });
    expect((await query(`SELECT id FROM deliveries`)).length).toBe(5);
    await drainSend(1, p);
    expect(await beginSend(1, AUD, snapshot())).toEqual({ ok: false, reason: "already-sent" });
  });

  it("lets two drains run at once without mailing anyone twice", async () => {
    await seed(400);
    await beginSend(1, AUD, snapshot());
    await Promise.all([drainSend(1, p), drainSend(1, p), drainSend(1, p)]);
    expect(await progress(1)).toMatchObject({ status: "sent", sent: 400 });
    expect(p.delivered).toHaveLength(400);
    expect(new Set(p.delivered).size).toBe(400);
  });
});
