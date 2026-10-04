// The flow engine against a real SQLite (node:sqlite behind @clawnify/db) with
// a fake scheduler and sender. What these pin down is the contract the engine
// exists for: a contact walks the chain once, no email is sent twice whatever
// the queue redelivers, consent is re-checked at every send, and editing a
// live flow never strands or double-mails a waiter.
import { beforeEach, describe, expect, it } from "vitest";
import { initDB, run, get, query } from "./db";
import * as flows from "./flows";
import { dueAtFor, reentryAllows, resolveLiveStep } from "./flows";

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
        return { rows: [] }; // rows only, no change counts
      },
    },
  });
}

/** Records scheduled wakes; the test fires them by hand to simulate the queue. */
class Harness {
  wakes: { enrollmentId: string; wakeSeq: number; dueAt: string }[] = [];
  sends: { mailId: number; to: string; key: string }[] = [];
  clock = 1_000_000_000_000; // fixed ms
  failKeys = new Set<string>(); // idempotency keys the provider always refuses
  failTimes = new Map<string, number>(); // key -> how many leading attempts fail, then succeed
  scheduleOk = true; // when false, the queue can't book a wake (no queue / enqueue failed)
  deps(): flows.FlowDeps {
    return {
      nowMs: () => this.clock,
      scheduleWake: async (enrollmentId, wakeSeq, dueAt) => {
        if (!this.scheduleOk) return false;
        this.wakes.push({ enrollmentId, wakeSeq, dueAt });
        return true;
      },
      send: async ({ mailId, contact, idempotencyKey }) => {
        if (this.failKeys.has(idempotencyKey)) return { ok: false, error: "refused" };
        const left = this.failTimes.get(idempotencyKey) ?? 0;
        if (left > 0) {
          this.failTimes.set(idempotencyKey, left - 1);
          return { ok: false, error: "transient 503" };
        }
        this.sends.push({ mailId, to: contact.email, key: idempotencyKey });
        return { ok: true, id: `msg-${this.sends.length}` };
      },
    };
  }
  /** Fire the most recently scheduled wake (optionally advancing the clock). */
  async fireLast(advanceMs = 0) {
    const w = this.wakes[this.wakes.length - 1];
    this.clock = Math.max(this.clock, Date.parse(w.dueAt)) + advanceMs;
    return flows.runWake(w.enrollmentId, w.wakeSeq, this.deps());
  }
}

async function makeContact(audienceId: string, email: string, source = "signup_form", status = "subscribed") {
  const id = `con_${email.replace(/\W/g, "")}`;
  await run(
    `INSERT INTO contacts (id, audience_id, email, first_name, status, consent_source) VALUES (?, ?, ?, 'Pat', ?, ?)`,
    [id, audienceId, email, status, source],
  );
  return id;
}

async function makeMail(title: string) {
  const row = (await get(`INSERT INTO mails (title) VALUES (?) RETURNING id`, [title])) as { id: number };
  return row.id;
}

/** email(now) -> delay(3d) -> email -> end. Returns the flow + step ids. */
async function welcomeFlow(audienceId: string | null, opts: { reentry?: flows.Reentry; consent_sources?: string[] } = {}) {
  const flow = await flows.createFlow({
    name: "Welcome",
    trigger_type: "subscribed",
    trigger_config: { audience_id: audienceId, consent_sources: opts.consent_sources },
    reentry: opts.reentry ?? "none",
  });
  const m1 = await makeMail("Welcome 1");
  const m2 = await makeMail("Welcome 2");
  const e1 = await flows.addStep(flow.id, "email", { mail_id: m1 });
  const d = await flows.addStep(flow.id, "delay", { seconds: 3 * 86400 });
  const e2 = await flows.addStep(flow.id, "email", { mail_id: m2 });
  const end = await flows.addStep(flow.id, "end");
  await flows.setNext(e1.id, d.id);
  await flows.setNext(d.id, e2.id);
  await flows.setNext(e2.id, end.id);
  await flows.setEntry(flow.id, e1.id);
  return { flow, e1, d, e2, end, m1, m2 };
}

beforeEach(useSqlite);

describe("pure helpers", () => {
  it("dueAtFor adds seconds to arrival", () => {
    expect(dueAtFor(60, Date.parse("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:01:00.000Z");
  });
  it("reentryAllows: none once, always every time, after respects the window", () => {
    expect(reentryAllows("none", null, null, 0)).toBe(true); // never enrolled
    expect(reentryAllows("none", null, 100, 200)).toBe(false);
    expect(reentryAllows("always", null, 100, 200)).toBe(true);
    expect(reentryAllows("after", 10, 1000, 1000 + 9_000)).toBe(false);
    expect(reentryAllows("after", 10, 1000, 1000 + 10_000)).toBe(true);
  });
  it("resolveLiveStep chases tombstones and stops on cycles", () => {
    const s = (id: string, next: string | null, del = false, fwd: string | null = null) =>
      ({ id, flow_id: "f", kind: "email", config: "{}", next_step_id: next, deleted_at: del ? "t" : null, forward_to_step_id: fwd }) as flows.FlowStep;
    const m = new Map([
      ["a", s("a", "b", true, "b")],
      ["b", s("b", "c", true, "c")],
      ["c", s("c", null)],
    ]);
    expect(resolveLiveStep(m, "a")?.id).toBe("c");
    const cyc = new Map([["x", s("x", null, true, "y")], ["y", s("y", null, true, "x")]]);
    expect(resolveLiveStep(cyc, "x")).toBeNull();
  });
});

describe("welcome series, happy path", () => {
  it("sends the first email at once, the second after the delay, then completes", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow, e2, m1, m2 } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");

    const enrolled = await flows.enrollOnSubscribed(
      { id: con, audience_id: "aud1", email: "pat@example.com", first_name: "Pat", consent_source: "signup_form" },
      h.deps(),
    );
    expect(enrolled).toHaveLength(1);

    // First wake (due now): sends email 1, parks at the delay.
    let r = await h.fireLast();
    expect(r).toMatchObject({ acted: true, state: "waiting" });
    expect(h.sends.map((s) => s.mailId)).toEqual([m1]);

    // Not yet due: the parked wake fired early no-ops.
    const parked = h.wakes[h.wakes.length - 1];
    expect(await flows.runWake(parked.enrollmentId, parked.wakeSeq, h.deps())).toMatchObject({ acted: false, reason: "not-due" });
    expect(h.sends).toHaveLength(1);

    // Delay elapses: second email, then completes.
    r = await h.fireLast();
    expect(r).toMatchObject({ acted: true, state: "completed" });
    expect(h.sends.map((s) => s.mailId)).toEqual([m1, m2]);

    const enr = (await get(`SELECT state FROM flow_enrollments WHERE flow_id = ?`, [flow.id])) as { state: string };
    expect(enr.state).toBe("completed");
    void e2;
  });
});

describe("idempotency", () => {
  it("a redelivered wake (same seq) sends the step only once", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow, m1 } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());

    const first = h.wakes[0];
    await flows.runWake(first.enrollmentId, first.wakeSeq, h.deps());
    // Queue redelivers the identical wake.
    const dup = await flows.runWake(first.enrollmentId, first.wakeSeq, h.deps());
    expect(dup).toMatchObject({ acted: false, reason: "superseded" });
    expect(h.sends.filter((s) => s.mailId === m1)).toHaveLength(1);
  });

  it("send-once holds even if two wakes with the same seq race past the guard", async () => {
    // Simulate the window before the claim bumps the seq by recording a 'sent'
    // event directly, then running the wake: it must not send again.
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow, e1, m1 } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    const enr = (await get(`SELECT id FROM flow_enrollments WHERE flow_id = ?`, [flow.id])) as { id: string };
    await run(`INSERT INTO flow_step_events (enrollment_id, step_id, outcome, detail) VALUES (?, ?, 'sent', 'earlier')`, [enr.id, e1.id]);

    const first = h.wakes[0];
    await flows.runWake(first.enrollmentId, first.wakeSeq, h.deps());
    expect(h.sends.filter((s) => s.mailId === m1)).toHaveLength(0); // already recorded as sent
  });
});

describe("editing a live flow", () => {
  it("editing a delay keeps a waiter's frozen due_at", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow, d } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    await h.fireLast(); // send email 1, park with due_at = now + 3d
    const before = (await get(`SELECT due_at FROM flow_enrollments WHERE flow_id = ?`, [flow.id])) as { due_at: string };

    await flows.editStepConfig(d.id, { seconds: 999 * 86400 }); // change the delay
    const after = (await get(`SELECT due_at FROM flow_enrollments WHERE flow_id = ?`, [flow.id])) as { due_at: string };
    expect(after.due_at).toBe(before.due_at); // waiter unaffected
  });

  it("deleting the delay forwards an arriving contact to the next email", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow, d, m1, m2 } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    await flows.deleteStep(flow.id, d.id); // remove the wait before anyone arrives
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());

    const r = await h.fireLast(); // no delay now: both emails, then complete, in one wake
    expect(r).toMatchObject({ acted: true, state: "completed" });
    expect(h.sends.map((s) => s.mailId)).toEqual([m1, m2]);
  });
});

describe("consent and exits", () => {
  it("an unsubscribe before the second email exits the enrollment", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow, m2 } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    await h.fireLast(); // email 1 sent, parked

    await run(`UPDATE contacts SET status = 'unsubscribed' WHERE id = ?`, [con]);
    const r = await h.fireLast(); // delay elapsed, but consent gone
    expect(r).toMatchObject({ acted: true, state: "exited" });
    expect(h.sends.map((s) => s.mailId)).not.toContain(m2);
    const enr = (await get(`SELECT exit_reason FROM flow_enrollments WHERE flow_id = ?`, [flow.id])) as { exit_reason: string };
    expect(enr.exit_reason).toBe("unsubscribed");
  });

  it("a transient send failure retries the same step with backoff, then succeeds", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow, e1, m1 } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    const enr = (await get(`SELECT id FROM flow_enrollments WHERE flow_id = ?`, [flow.id])) as { id: string };
    h.failTimes.set(`flow-${enr.id}-${e1.id}`, 2); // first two attempts fail

    let r = await h.fireLast(); // attempt 1 fails -> re-parked on e1
    expect(r).toMatchObject({ acted: true, state: "waiting" });
    expect(h.sends).toHaveLength(0);
    r = await h.fireLast(); // attempt 2 fails -> re-parked again
    expect(r).toMatchObject({ acted: true, state: "waiting" });
    r = await h.fireLast(); // attempt 3 succeeds -> sends, parks at the real delay
    expect(h.sends.map((s) => s.mailId)).toEqual([m1]);
    const retries = (await get(`SELECT COUNT(*) AS n FROM flow_step_events WHERE enrollment_id = ? AND step_id = ? AND outcome = 'retry'`, [enr.id, e1.id])) as { n: number };
    expect(Number(retries.n)).toBe(2);
  });

  it("a permanently refused send is given up on after the cap, and the flow continues", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow, e1, m1, m2 } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    const enr = (await get(`SELECT id FROM flow_enrollments WHERE flow_id = ?`, [flow.id])) as { id: string };
    h.failKeys.add(`flow-${enr.id}-${e1.id}`); // email 1 never sends

    // SEND_MAX_ATTEMPTS attempts at email 1, each re-parking, then it's given up.
    for (let i = 0; i < flows.SEND_MAX_ATTEMPTS; i++) await h.fireLast();
    const failed = (await get(`SELECT outcome FROM flow_step_events WHERE enrollment_id = ? AND step_id = ? AND outcome = 'failed'`, [enr.id, e1.id])) as { outcome: string } | null;
    expect(failed?.outcome).toBe("failed");
    expect(h.sends.map((s) => s.mailId)).not.toContain(m1);

    // The flow still advances past the failed email: the delay, then email 2.
    await h.fireLast();
    expect(h.sends.map((s) => s.mailId)).toContain(m2);
  });
});

describe("enrollment rules", () => {
  it("re-entry 'none' enrolls once; a later subscribe does not re-enroll", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow } = await welcomeFlow("aud1", { reentry: "none" });
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    const c = { id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" };
    await flows.enrollOnSubscribed(c, h.deps());
    // complete the journey
    await h.fireLast();
    await h.fireLast();
    const again = await flows.enrollOnSubscribed(c, h.deps());
    expect(again).toHaveLength(0);
  });

  it("an imported contact does not enroll (consent source excluded by default)", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow } = await welcomeFlow("aud1"); // default sources: signup_form, manual
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "imported@example.com", "import");
    const enrolled = await flows.enrollOnSubscribed(
      { id: con, audience_id: "aud1", email: "imported@example.com", consent_source: "import" },
      h.deps(),
    );
    expect(enrolled).toHaveLength(0);
  });

  it("a draft flow does not enroll anyone", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow } = await welcomeFlow("aud1"); // left as draft
    void flow;
    const con = await makeContact("aud1", "pat@example.com");
    const enrolled = await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    expect(enrolled).toHaveLength(0);
  });
});

describe("pause / resume / archive", () => {
  it("a wake while paused no-ops; resume re-books due waiters and the send goes out", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow, m2 } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    await h.fireLast(); // email 1, parked at delay

    await flows.setFlowStatus(flow.id, "paused", h.deps());
    const parked = h.wakes[h.wakes.length - 1];
    h.clock = Date.parse(parked.dueAt) + 1000; // delay elapsed
    expect(await flows.runWake(parked.enrollmentId, parked.wakeSeq, h.deps())).toMatchObject({ acted: false, reason: "flow-paused" });
    expect(h.sends.map((s) => s.mailId)).not.toContain(m2);

    await flows.setFlowStatus(flow.id, "live", h.deps()); // resume re-books due waiters
    await h.fireLast();
    expect(h.sends.map((s) => s.mailId)).toContain(m2);
  });

  it("archiving exits every waiter", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    await h.fireLast(); // parked at delay

    await flows.setFlowStatus(flow.id, "archived", h.deps());
    const enr = (await get(`SELECT state, exit_reason FROM flow_enrollments WHERE flow_id = ?`, [flow.id])) as { state: string; exit_reason: string };
    expect(enr.state).toBe("exited");
    expect(enr.exit_reason).toBe("flow_archived");
  });
});

describe("durability: a wake is never bumped away without a replacement", () => {
  it("enroll that can't book its first wake leaves no blocking row", async () => {
    const h = new Harness();
    h.scheduleOk = false; // queue unavailable
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    const enrolled = await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    expect(enrolled).toHaveLength(0);
    const row = (await get(`SELECT COUNT(*) AS n FROM flow_enrollments WHERE flow_id = ?`, [flow.id])) as { n: number };
    expect(Number(row.n)).toBe(0); // no phantom waiting row to block re-enrollment
  });

  it("runWake throws (so the queue retries) when it cannot book the next wake", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    const w = h.wakes[0];
    h.clock = Date.parse(w.dueAt);
    h.scheduleOk = false; // the park after sending email 1 can't book its wake
    await expect(flows.runWake(w.enrollmentId, w.wakeSeq, h.deps())).rejects.toThrow();
    // Enrollment is NOT advanced: still at the entry step, same seq, so the
    // redelivered job matches and retries.
    const enr = (await get(`SELECT current_step_id, wake_seq, state FROM flow_enrollments WHERE id = ?`, [w.enrollmentId])) as { current_step_id: string; wake_seq: number; state: string };
    expect(enr.wake_seq).toBe(0);
    expect(enr.state).toBe("waiting");
  });

  it("a wake that fires before due_at re-books instead of dropping", async () => {
    const h = new Harness();
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const { flow } = await welcomeFlow("aud1");
    await flows.setFlowStatus(flow.id, "live", h.deps());
    const con = await makeContact("aud1", "pat@example.com");
    await flows.enrollOnSubscribed({ id: con, audience_id: "aud1", email: "pat@example.com", consent_source: "signup_form" }, h.deps());
    await h.fireLast(); // email 1, parked at the delay with a future due_at
    const parked = h.wakes[h.wakes.length - 1];
    const before = h.wakes.length;
    h.clock = Date.parse(parked.dueAt) - 60_000; // deliver a minute early
    const r = await flows.runWake(parked.enrollmentId, parked.wakeSeq, h.deps());
    expect(r).toMatchObject({ acted: false, reason: "not-due" });
    expect(h.wakes.length).toBe(before + 1); // a replacement wake was booked
    expect(h.wakes[h.wakes.length - 1].wakeSeq).toBe(parked.wakeSeq + 1);
  });
});

describe("validation (turn-on refusals)", () => {
  it("flags an email step whose mail is not ready and a path that never ends", async () => {
    await run(`INSERT INTO audiences (id, name) VALUES ('aud1', 'A')`);
    const flow = await flows.createFlow({ name: "Bad", trigger_type: "subscribed" });
    const m = await makeMail("Draft");
    const e1 = await flows.addStep(flow.id, "email", { mail_id: m });
    const d = await flows.addStep(flow.id, "delay", { seconds: 60 });
    await flows.setNext(e1.id, d.id);
    // d.next is null: the path never reaches an End.
    await flows.setEntry(flow.id, e1.id);
    const issues = await flows.validateFlow(flow.id, async () => "Needs a subject");
    const msgs = issues.map((i) => i.message);
    expect(msgs).toContain("Needs a subject");
    expect(msgs.some((m) => m.includes("nothing after it"))).toBe(true);
  });
});
