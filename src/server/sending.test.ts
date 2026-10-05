// The send engine against a real SQLite (node:sqlite behind @clawnify/db's
// StorageBinding) and a fake provider that deduplicates by idempotency key the
// way Resend does. What these pin down is the thing the engine exists for: no
// recipient is mailed twice, and nobody is silently dropped, whatever the
// provider answers.
import { beforeEach, describe, expect, it } from "vitest";
import { initDB, query, run, get } from "./db";
import { BATCH_SIZE, KEY_TTL_MS, MAX_RETRIES, STALE_CLAIM_MS, beginSend, drainSend, progress, type SendSnapshot } from "./sending";
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
        stmt.run(...(params as any[]));
        // Rows only, no change counts, as some storage bindings return. The
        // engine must never depend on them.
        return { rows: [] };
      },
    },
  });
}

/**
 * Deduplicates by key like Resend, for 24 hours. `gate` runs *before* the
 * dedupe lookup, as throttling and auth checks do at a real API edge: a
 * refusal there says nothing about an earlier attempt under the same key.
 */
class FakeProvider implements EmailProvider {
  readonly name = "fake";
  delivered: string[] = [];
  calls: SendBatchInput[] = [];
  clock = () => 0;
  gate: (input: SendBatchInput, call: number) => BatchOutcome | null = () => null;
  script: (input: SendBatchInput, call: number) => BatchOutcome | "deliver-then-unknown" = () => ({ kind: "sent", ids: [] });
  private seen = new Map<string, { at: number; out: BatchOutcome; payload: string }>();

  get batchCalls() { return this.calls.filter((c) => c.messages.length > 1 || !c.idempotencyKey.includes("/dlv_")); }
  async listDomains() { return []; }
  async sendEmail(): Promise<never> { throw new Error("the engine sends through sendBatch only"); }
  async sendBatch(input: SendBatchInput): Promise<BatchOutcome> {
    this.calls.push(input);
    const call = this.calls.length;
    const refused = this.gate(input, call);
    if (refused) return refused;
    const prior = this.seen.get(input.idempotencyKey);
    const payload = JSON.stringify([input.from, input.subject, input.messages]);
    if (prior && this.clock() - prior.at < 24 * 3600_000) {
      return prior.payload === payload ? prior.out : { kind: "unknown", message: "409 invalid_idempotent_request" };
    }
    const planned = this.script(input, call);
    const ok: BatchOutcome = { kind: "sent", ids: input.messages.map((m: { to: string }) => `id-${m.to}`) };
    if (planned === "deliver-then-unknown") {
      this.seen.set(input.idempotencyKey, { at: this.clock(), out: ok, payload });
      this.delivered.push(...input.messages.map((m: { to: string }) => m.to));
      return { kind: "unknown", message: "timeout" };
    }
    if (planned.kind === "sent") {
      this.seen.set(input.idempotencyKey, { at: this.clock(), out: ok, payload });
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
    id: 1, eyebrow: "", title: "Issue 1", preheader: "", subtitle: "", byline_name: "", byline_date: "", feature_image: "",
    blocks: [], design: null, design_mobile: null, template_slug: null, audience_id: AUD,
    broadcast_id: null, created_at: "",
  },
  design: DEFAULT_DESIGN,
  settings: { publication_name: "Pub", logo: "", from_name: "", from_email: "a@b.co", senders: [], default_audience_id: AUD, footer_text: "", crm_app_id: null },
  from: "a@b.co",
  origin: "https://pub.apps.clawnify.com",
});

const status = async () => (await get<{ status: string }>(`SELECT status FROM mails WHERE id = 1`))!.status;

const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const dupes = (xs: string[]) => Object.entries(count(xs)).filter(([, n]) => n > 1).map(([x]) => x);
const single = (i: SendBatchInput) => i.messages.length === 1 && i.idempotencyKey.includes("/dlv_");

describe("send engine", () => {
  let p: FakeProvider;
  beforeEach(() => {
    useSqlite();
    p = new FakeProvider();
  });

  // A queued job checks the schedule, then claims. An operator who cancels or
  // moves the schedule between the two must win, or a cancelled issue goes out.
  it("lets a queued job claim only a mail still scheduled for that job's time", async () => {
    await seed(3);
    const AT = "2026-10-05T12:00:00.000Z";
    expect(await beginSend(1, AUD, snapshot(), AT)).toEqual({ ok: false, reason: "not-found" });
    await run(`UPDATE mails SET status = 'scheduled', scheduled_at = ? WHERE id = 1`, ["2026-10-05T13:00:00.000Z"]);
    expect((await beginSend(1, AUD, snapshot(), AT)).ok).toBe(false);
    expect(await status()).toBe("scheduled");
    await run(`UPDATE mails SET scheduled_at = ? WHERE id = 1`, [AT]);
    expect((await beginSend(1, AUD, snapshot(), AT)).ok).toBe(true);
    expect(await status()).toBe("sending");
  });

  it("lets a job from before scheduled_for existed claim any scheduled time, never a draft", async () => {
    await seed(3);
    expect((await beginSend(1, AUD, snapshot(), null)).ok).toBe(false);
    await run(`UPDATE mails SET status = 'scheduled', scheduled_at = ? WHERE id = 1`, ["2026-10-05T13:00:00.000Z"]);
    expect((await beginSend(1, AUD, snapshot(), null)).ok).toBe(true);
  });

  it("sends every confirmed subscriber once, in fixed batches, each under its own key", async () => {
    await seed(250, [{ email: "pending@example.com", status: "pending" }, { email: "gone@example.com", status: "unsubscribed" }]);
    expect((await beginSend(1, AUD, snapshot())).ok).toBe(true);

    const r = await drainSend(1, p);
    expect(r).toMatchObject({ status: "sent", sent: 250, failed: 0, open: 0 });
    expect(await status()).toBe("sent");
    expect(p.delivered).toHaveLength(250);
    expect(dupes(p.delivered)).toEqual([]);
    expect(p.calls.map((b) => b.messages.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 50]);
    expect(new Set(p.calls.map((b) => b.idempotencyKey)).size).toBe(3);
    const first = p.calls[0].messages[0];
    expect(first.html).toContain(first.unsubscribeUrl);
    expect(first.deliveryId).toMatch(/^dlv_/);
    const ids = await query<{ provider_message_id: string; email: string }>(`SELECT provider_message_id, email FROM deliveries`);
    expect(ids.every((d) => d.provider_message_id === `id-${d.email}`)).toBe(true);
  });

  it("retries a lost answer under the same key, so the batch is not mailed twice", async () => {
    await seed(120);
    await beginSend(1, AUD, snapshot());
    p.script = (_input, call) => (call === 1 ? "deliver-then-unknown" : { kind: "sent", ids: [] });

    let t = Date.parse("2026-09-30T10:00:00Z");
    p.clock = () => t;
    expect(await drainSend(1, p, { now: () => t })).toMatchObject({ status: "sending", sent: 20, open: 100 });

    await drainSend(1, p, { now: () => t }); // not stale yet: nothing retried
    expect(p.calls).toHaveLength(2);

    t += STALE_CLAIM_MS + 1;
    expect(await drainSend(1, p, { now: () => t })).toMatchObject({ status: "sent", sent: 120, open: 0 });
    expect(p.calls[2].idempotencyKey).toBe(p.calls[0].idempotencyKey);
    expect(p.delivered).toHaveLength(120);
  });

  // A refusal on a retry must not drop a key an earlier attempt may have used.
  for (const refusal of [
    { name: "a rate limit at the deadline", out: { kind: "rate_limited", retryAfterMs: 60_000 } as BatchOutcome },
    { name: "a revoked key", out: { kind: "fatal", message: "Resend 401: key revoked" } as BatchOutcome },
  ]) {
    it(`keeps a risky key through ${refusal.name} on the retry`, async () => {
      await seed(5);
      await beginSend(1, AUD, snapshot());
      let t = 0;
      p.clock = () => t;
      p.script = (_i, call) => (call === 1 ? "deliver-then-unknown" : { kind: "sent", ids: [] });
      await drainSend(1, p, { now: () => t, deadline: 10_000 });

      t += STALE_CLAIM_MS + 1;
      p.gate = (_i, call) => (call === 2 ? refusal.out : null);
      await drainSend(1, p, { now: () => t, deadline: t + 10_000 });
      p.gate = () => null;
      await beginSend(1, AUD, snapshot()); // resume, in case the refusal stopped the send
      await drainSend(1, p, { now: () => t });

      expect(new Set(p.calls.map((c) => c.idempotencyKey)).size).toBe(1);
      expect(p.delivered).toHaveLength(5);
      expect(await progress(1)).toMatchObject({ status: "sent", sent: 5 });
    });
  }

  it("records a risky key that never gets an answer as failed after MAX_RETRIES, saying it may have arrived", async () => {
    await seed(3);
    await beginSend(1, AUD, snapshot());
    p.script = () => ({ kind: "unknown", message: "503" });
    let t = 0;
    for (let i = 0; i <= MAX_RETRIES + 1; i++) {
      await drainSend(1, p, { now: () => t });
      t += STALE_CLAIM_MS + 1;
    }
    expect(p.calls).toHaveLength(MAX_RETRIES + 1);
    expect(await progress(1)).toMatchObject({ status: "failed", failed: 3, sent: 0, open: 0 });
    const errs = await query<{ error: string }>(`SELECT error FROM deliveries`);
    expect(errs[0].error).toMatch(/may have been delivered/);
  });

  // Past the provider's 24h memory a retry could duplicate.
  it("does not retry a risky key once the provider could have forgotten it", async () => {
    await seed(4);
    await beginSend(1, AUD, snapshot());
    let t = 0;
    p.clock = () => t;
    p.script = (_i, call) => (call === 1 ? "deliver-then-unknown" : { kind: "sent", ids: [] });
    await drainSend(1, p, { now: () => t });
    t += KEY_TTL_MS + 1;
    const r = await drainSend(1, p, { now: () => t });
    expect(p.calls).toHaveLength(1);
    expect(p.delivered).toHaveLength(4);
    expect(r).toMatchObject({ status: "failed", failed: 4, open: 0 });
  });

  it("isolates one bad address instead of failing its whole batch", async () => {
    await seed(5, [{ email: "bad@", status: "subscribed" }]);
    await beginSend(1, AUD, snapshot());
    p.script = (i) =>
      i.messages.some((m: { to: string }) => m.to === "bad@") ? { kind: "invalid", message: "invalid `to`" } : { kind: "sent", ids: [] };
    const r = await drainSend(1, p);
    expect(r).toMatchObject({ status: "sent", sent: 5, failed: 1 });
    expect(p.calls.filter(single)).toHaveLength(6);
  });

  // Transient errors on single sends must not fail good recipients.
  it("treats 429s and 5xx on single sends as retryable, not as failed recipients", async () => {
    await seed(4, [{ email: "bad@", status: "subscribed" }]);
    await beginSend(1, AUD, snapshot());
    let n = 0;
    p.script = (i) => {
      if (i.messages.some((m: { to: string }) => m.to === "bad@")) return { kind: "invalid", message: "invalid `to`" };
      if (single(i) && n++ === 0) return { kind: "unknown", message: "502" };
      return { kind: "sent", ids: [] };
    };
    p.gate = (i, call) => (single(i) && call === 3 ? { kind: "rate_limited", retryAfterMs: 1000 } : null);
    let t = 0;
    const waits: number[] = [];
    await drainSend(1, p, { now: () => t, sleep: async (ms) => { waits.push(ms); } });
    t += STALE_CLAIM_MS + 1;
    const r = await drainSend(1, p, { now: () => t });
    expect(waits).toEqual([1000]);
    expect(r).toMatchObject({ status: "sent", sent: 4, failed: 1 });
    expect(dupes(p.delivered)).toEqual([]);
  });

  it("stops on a fatal refusal with nothing marked sent, and resumes under a fresh key once fixed", async () => {
    await seed(150);
    await beginSend(1, AUD, snapshot());
    p.gate = () => ({ kind: "fatal", message: "Resend 403: domain not verified" });
    expect(await drainSend(1, p)).toMatchObject({ status: "failed", sent: 0, open: 150, error: "Resend 403: domain not verified" });

    const refusedKey = p.calls[0].idempotencyKey;
    p.gate = () => null;
    expect(await beginSend(1, AUD, snapshot())).toMatchObject({ ok: true, resumed: true });
    expect(await drainSend(1, p)).toMatchObject({ status: "sent", sent: 150 });
    expect(p.delivered).toHaveLength(150);
    expect(p.calls[1].idempotencyKey).not.toBe(refusedKey);
  });

  it("treats a batch where every single send is rejected the same way as a stopped send", async () => {
    await seed(4);
    await beginSend(1, AUD, snapshot());
    p.script = () => ({ kind: "invalid", message: "Resend 422: invalid `from`" });
    const r = await drainSend(1, p);
    expect(r).toMatchObject({ status: "failed", open: 4, failed: 0, error: "Resend 422: invalid `from`" });
    // Released without a key, so the retry after the fix is a normal batch again.
    const rows = await query<{ status: string; single: number; send_key: string | null }>(`SELECT DISTINCT status, single, send_key FROM deliveries`);
    expect(rows).toEqual([{ status: "pending", single: 0, send_key: null }]);
  });

  it("waits out a rate limit and retries the same batch under the same key", async () => {
    await seed(10);
    await beginSend(1, AUD, snapshot());
    p.gate = (_i, call) => (call === 1 ? { kind: "rate_limited", retryAfterMs: 1000 } : null);
    const waits: number[] = [];
    const r = await drainSend(1, p, { sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([1000]);
    expect(r).toMatchObject({ status: "sent", sent: 10 });
    expect(p.calls[0].idempotencyKey).toBe(p.calls[1].idempotencyKey);
  });

  it("hands a rate-limited batch back instead of waiting past the deadline", async () => {
    await seed(10);
    await beginSend(1, AUD, snapshot());
    p.gate = () => ({ kind: "rate_limited", retryAfterMs: 5000 });
    const r = await drainSend(1, p, { deadline: 3000, now: () => 0 });
    expect(r).toMatchObject({ status: "sending", open: 10 });
    const rows = await query<{ status: string; retries: number; send_key: string | null }>(`SELECT DISTINCT status, retries, send_key FROM deliveries`);
    expect(rows).toEqual([{ status: "pending", retries: 0, send_key: null }]);
  });

  it("stops starting batches at the deadline and leaves the rest waiting", async () => {
    await seed(300);
    await beginSend(1, AUD, snapshot());
    let t = 0;
    p.script = () => { t += 1000; return { kind: "sent", ids: [] }; };
    expect(await drainSend(1, p, { deadline: 2000, now: () => t })).toMatchObject({ status: "sending", sent: 200, open: 100 });
    expect(await drainSend(1, p)).toMatchObject({ status: "sent", sent: 300 });
  });

  it("skips someone who unsubscribed after the send began, and ignores people who joined", async () => {
    await seed(3);
    await beginSend(1, AUD, snapshot());
    await run(`UPDATE contacts SET status = 'unsubscribed' WHERE email = 'r1@example.com'`);
    await run(`INSERT INTO contacts (id, audience_id, email, status) VALUES ('con_late', ?, 'late@example.com', 'subscribed')`, [AUD]);
    expect(await drainSend(1, p)).toMatchObject({ status: "sent", sent: 2, skipped: 1 });
    expect(p.delivered.sort()).toEqual(["r0@example.com", "r2@example.com"]);
  });

  it("resumes rather than restarts, writes recipients once under concurrency, and refuses a sent issue", async () => {
    await seed(5);
    const [a, b] = await Promise.all([beginSend(1, AUD, snapshot()), beginSend(1, AUD, snapshot())]);
    expect([a, b].filter((x) => x.ok && !x.resumed)).toHaveLength(1);
    expect((a as { sendId: string }).sendId).toBe((b as { sendId: string }).sendId);
    await run(`INSERT INTO contacts (id, audience_id, email, status) VALUES ('con_late', ?, 'late@example.com', 'subscribed')`, [AUD]);
    await beginSend(1, AUD, snapshot());
    expect((await query(`SELECT id FROM deliveries`)).length).toBe(5);
    await drainSend(1, p);
    expect(await beginSend(1, AUD, snapshot())).toEqual({ ok: false, reason: "already-sent" });
  });

  it("lets several drains run at once without mailing anyone twice", async () => {
    await seed(400);
    await beginSend(1, AUD, snapshot());
    await Promise.all([drainSend(1, p), drainSend(1, p), drainSend(1, p)]);
    expect(await progress(1)).toMatchObject({ status: "sent", sent: 400 });
    expect(p.delivered).toHaveLength(400);
    expect(dupes(p.delivered)).toEqual([]);
  });

  // A risky key must never be traded for new keys.
  it("records risky rows as maybe-delivered when a resume changes the snapshot, instead of resending them", async () => {
    await seed(150);
    await beginSend(1, AUD, snapshot());
    let t = 0;
    p.clock = () => t;
    p.script = (_i, call) => (call === 1 ? "deliver-then-unknown" : { kind: "sent", ids: [] });
    p.gate = (_i, call) => (call === 2 ? { kind: "fatal", message: "Resend 429: monthly quota" } : null);
    await drainSend(1, p, { now: () => t });
    expect(await status()).toBe("failed");

    p.gate = () => null;
    await beginSend(1, AUD, { ...snapshot(), from: "b@b.co" }); // the operator changed the sender
    t += STALE_CLAIM_MS + 1;
    const r = await drainSend(1, p, { now: () => t });
    expect(dupes(p.delivered)).toEqual([]);
    expect(r).toMatchObject({ status: "sent", sent: 50, failed: 100, open: 0 });
  });

  it("does not split a risky batch into single sends when its retry is rejected", async () => {
    await seed(3);
    await beginSend(1, AUD, snapshot());
    let t = 0;
    p.clock = () => t;
    p.script = (_i, call) => (call === 1 ? "deliver-then-unknown" : { kind: "sent", ids: [] });
    await drainSend(1, p, { now: () => t });
    t += STALE_CLAIM_MS + 1;
    p.gate = () => ({ kind: "invalid", message: "Resend 422: something changed" });
    const r = await drainSend(1, p, { now: () => t });
    expect(p.calls.filter(single)).toHaveLength(0);
    expect(r).toMatchObject({ status: "failed", failed: 3 });
    expect(p.delivered).toHaveLength(3);
  });

  // Several bad addresses are not an account problem.
  it("fails bad addresses one by one instead of stopping the send, even with nothing else in the batch", async () => {
    await seed(0, [{ email: "bad1@", status: "subscribed" }, { email: "bad2@", status: "subscribed" }]);
    await beginSend(1, AUD, snapshot());
    p.script = () => ({ kind: "invalid", message: "Invalid `to` field. The email address needs to follow the `email@example.com` format." });
    const r = await drainSend(1, p);
    expect(r).toMatchObject({ status: "failed", failed: 2, open: 0 });
    expect(r.error).toBe("No recipient could be sent this issue.");
  });

  it("keeps treating identical rejections as an address problem once the send has had a success", async () => {
    await seed(100, [{ email: "bad1@", status: "subscribed" }, { email: "bad2@", status: "subscribed" }]);
    await beginSend(1, AUD, snapshot());
    p.script = (i) =>
      i.messages.some((m: { to: string }) => m.to.startsWith("bad")) ? { kind: "invalid", message: "Resend 422: rejected" } : { kind: "sent", ids: [] };
    const r = await drainSend(1, p);
    expect(r).toMatchObject({ status: "sent", sent: 100, failed: 2, open: 0 });
  });

  // A claim whose worker died before calling the provider sent nothing.
  it("resends a stale claim that never reached the provider, even a day later", async () => {
    await seed(4);
    await beginSend(1, AUD, snapshot());
    await run(`UPDATE deliveries SET status = 'sending', claimed_at = ?, send_key = 'k0', key_at = ?, in_flight = 0`, [
      new Date(0).toISOString(),
      new Date(0).toISOString(),
    ]);
    const r = await drainSend(1, p, { now: () => KEY_TTL_MS + STALE_CLAIM_MS + 1 });
    expect(r).toMatchObject({ status: "sent", sent: 4 });
  });

  it("treats a stale claim whose request was in flight as risky", async () => {
    await seed(4);
    await beginSend(1, AUD, snapshot());
    await run(`UPDATE deliveries SET status = 'sending', claimed_at = ?, send_key = 'k0', key_at = ?, in_flight = 1`, [
      new Date(0).toISOString(),
      new Date(0).toISOString(),
    ]);
    const r = await drainSend(1, p, { now: () => KEY_TTL_MS + STALE_CLAIM_MS + 1 });
    expect(p.calls).toHaveLength(0);
    expect(r).toMatchObject({ status: "failed", failed: 4 });
  });

  // A refusal tested nothing, so it doesn't use up a risky key's retries.
  it("doesn't let repeated rate limits exhaust a risky key's retries", async () => {
    await seed(2);
    await beginSend(1, AUD, snapshot());
    let t = 0;
    p.clock = () => t;
    p.script = (_i, call) => (call === 1 ? "deliver-then-unknown" : { kind: "sent", ids: [] });
    await drainSend(1, p, { now: () => t, deadline: t + 1000 });
    p.gate = () => ({ kind: "rate_limited", retryAfterMs: 60_000 });
    for (let i = 0; i < MAX_RETRIES + 2; i++) {
      t += STALE_CLAIM_MS + 1;
      await drainSend(1, p, { now: () => t, deadline: t + 1000 });
    }
    p.gate = () => null;
    const r = await drainSend(1, p, { now: () => t });
    expect(r).toMatchObject({ status: "sent", sent: 2 });
    expect(p.delivered).toHaveLength(2);
  });
});

describe("merge tags in a send", () => {
  let p: FakeProvider;
  beforeEach(async () => {
    useSqlite();
    p = new FakeProvider();
    await run(`INSERT INTO audiences (id, name) VALUES (?, 'List')`, [AUD]);
    await run(`INSERT INTO contacts (id, audience_id, email, first_name, status) VALUES ('con_a', ?, 'ada@example.com', 'Ada', 'subscribed')`, [AUD]);
    await run(`INSERT INTO contacts (id, audience_id, email, first_name, status) VALUES ('con_b', ?, 'nameless@example.com', '', 'subscribed')`, [AUD]);
    await run(`INSERT INTO mails (id, title, audience_id, status) VALUES (1, 'Issue 1', ?, 'draft')`, [AUD]);
  });

  const greeting = (merge: boolean): SendSnapshot => {
    const snap = snapshot();
    snap.mail.blocks = [{ id: "b1", type: "text", md: "Hi {{first_name|there}}," }];
    return merge ? { ...snap, renderer: 2 } : snap;
  };
  const htmlFor = (to: string) => p.calls.flatMap((c) => c.messages).filter((m) => m.to === to).map((m) => m.html);

  it("fills each reader's name, and the fallback when there is none", async () => {
    await beginSend(1, AUD, greeting(true));
    expect(await drainSend(1, p)).toMatchObject({ status: "sent", sent: 2 });
    expect(htmlFor("ada@example.com")[0]).toContain("Hi Ada,");
    expect(htmlFor("nameless@example.com")[0]).toContain("Hi there,");
  });

  // A retry reuses its idempotency key, and a key reused with a different
  // payload is refused. So the names a send uses are the ones it started with.
  it("keeps the names from when the send began, so a retried batch carries the same payload", async () => {
    p.script = (_i, call) => (call === 1 ? "deliver-then-unknown" : { kind: "sent", ids: [] });
    await beginSend(1, AUD, greeting(true));
    await drainSend(1, p);
    await run(`UPDATE contacts SET first_name = 'Grace' WHERE id = 'con_a'`);
    await run(`UPDATE deliveries SET claimed_at = '2000-01-01T00:00:00.000Z' WHERE mail_id = 1`);
    const r = await drainSend(1, p);
    expect(r).toMatchObject({ status: "sent", sent: 2, failed: 0 });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1].idempotencyKey).toBe(p.calls[0].idempotencyKey);
    expect(htmlFor("ada@example.com").every((h) => h.includes("Hi Ada,"))).toBe(true);
    expect(dupes(p.delivered)).toEqual([]);
  });

  it("renders a send begun before the upgrade exactly as before: tags as written, old column padding", async () => {
    const snap = greeting(false);
    snap.mail.title = "For {{first_name}}";
    snap.mail.blocks.push({ id: "c", type: "columns", items: [{ image: "", heading: "A", text: "a" }, { image: "", heading: "B", text: "b" }] });
    await beginSend(1, AUD, snap);
    await drainSend(1, p);
    const html = htmlFor("ada@example.com")[0];
    expect(html).toContain("Hi {{first_name|there}},");
    expect(html).toContain("padding:0 8px;");
    expect(p.calls[0].messages.every((m) => m.subject === undefined)).toBe(true);
  });

  it("personalizes the subject per reader, on one line", async () => {
    await run(`UPDATE contacts SET first_name = 'Ada\r\nBcc: x@evil.example' WHERE id = 'con_a'`);
    const snap = greeting(true);
    snap.mail.title = "{{first_name|Friend}}, your week";
    await beginSend(1, AUD, snap);
    await drainSend(1, p);
    const subjects = Object.fromEntries(p.calls.flatMap((c) => c.messages).map((m) => [m.to, m.subject]));
    expect(subjects["ada@example.com"]).toBe("Ada Bcc: x@evil.example, your week");
    expect(subjects["nameless@example.com"]).toBe("Friend, your week");
  });

  it("gives rows written before names were copied their names when a failed send resumes", async () => {
    p.gate = () => ({ kind: "fatal", message: "domain not verified" });
    await beginSend(1, AUD, greeting(false));
    await drainSend(1, p);
    await run(`UPDATE deliveries SET first_name = NULL, last_name = NULL`);
    p.gate = () => null;
    await beginSend(1, AUD, greeting(true));
    await drainSend(1, p);
    expect(htmlFor("ada@example.com").at(-1)).toContain("Hi Ada,");
  });
});
