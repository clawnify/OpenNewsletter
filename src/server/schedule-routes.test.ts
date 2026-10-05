// Scheduling through the routes: who may move a mail's schedule, and what a
// queued job does when it finds the mail can't be sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jobs: { payload: any; runAt: string }[] = [];
vi.mock("@clawnify/queue", () => ({
  enqueueJob: async (_env: unknown, job: { payload: any; runAt: string }) => { jobs.push(job); },
  verifyDelivery: async () => true,
}));

// Re-imported per test: the app runs its boot migrations once per module
// instance, and every test here starts from a fresh database.
let app: typeof import("./index").default;

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

let db: any;
let env: Record<string, unknown>;
let domains: { name: string; status: string }[];
beforeEach(async () => {
  vi.resetModules();
  app = (await import("./index")).default;
  jobs.length = 0;
  domains = [{ name: "example.com", status: "verified" }];
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  env = {
    RESEND_API_KEY: "re_test",
    CLAWNIFY_TOKEN: "clw_test",
    STORAGE: {
      async query(sql: string, params: unknown[] = []) {
        const stmt = db.prepare(sql);
        if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: stmt.all(...(params as any[])) };
        stmt.run(...(params as any[]));
        return { rows: [] };
      },
    },
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/domains")) return Response.json({ data: domains });
    if (String(url).endsWith("/emails/batch")) {
      return Response.json({ data: (JSON.parse(String(init?.body)) as unknown[]).map((_, i) => ({ id: `msg_${i}` })) });
    }
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const ORIGIN = "https://news.apps.clawnify.com";
const call = async (method: string, path: string, body?: unknown) =>
  app.request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const mailRow = (id: number) => db.prepare(`SELECT status, scheduled_at, send_error FROM mails WHERE id = ?`).get(id);
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

async function readyMail(subscribers = 1) {
  await call("PUT", "/api/settings", { from_name: "Ann", from_email: "ann@example.com" });
  const m: any = await (await call("POST", "/api/mails", {})).json();
  const audience = ((await (await call("GET", "/api/audiences")).json()) as any)[0].id;
  await call("PUT", `/api/mails/${m.id}`, { audience_id: audience });
  for (let i = 0; i < subscribers; i++) {
    db.prepare(`INSERT INTO contacts (id, audience_id, email, status, consent_source) VALUES (?, ?, ?, 'subscribed', 'manual')`)
      .run(`c${i}`, audience, `r${i}@example.com`);
  }
  return m.id as number;
}

describe("scheduling a send", () => {
  it("refuses a time without a timezone instead of reading it as UTC", async () => {
    const id = await readyMail();
    const res = await call("POST", `/api/mails/${id}/send`, { scheduled_at: "2026-12-01T14:00" });
    expect(res.status).toBe(400);
    expect(jobs).toHaveLength(0);
    expect(mailRow(id).status).toBe("draft");
  });

  it("stores the instant the offset names", async () => {
    const id = await readyMail();
    const res = await call("POST", `/api/mails/${id}/send`, { scheduled_at: "2099-12-01T14:00:00+01:00" });
    expect(res.status).toBe(200);
    expect(mailRow(id)).toMatchObject({ status: "scheduled", scheduled_at: "2099-12-01T13:00:00.000Z" });
    expect(jobs[0].runAt).toBe("2099-12-01T13:00:00.000Z");
  });
});

describe("the mail PUT and the schedule", () => {
  // The editor's undo restores a whole earlier copy of the mail, status included.
  it("ignores status and scheduled_at, so an undo can't cancel or move a schedule", async () => {
    const id = await readyMail();
    const at = inAnHour();
    await call("POST", `/api/mails/${id}/send`, { scheduled_at: at });
    await call("PUT", `/api/mails/${id}`, { status: "draft", scheduled_at: null, preheader: "edited" });
    expect(mailRow(id)).toMatchObject({ status: "scheduled", scheduled_at: at });
    expect(db.prepare(`SELECT preheader FROM mails WHERE id = ?`).get(id).preheader).toBe("edited");
  });

  it("can't mark a draft scheduled with no job behind it", async () => {
    const id = await readyMail();
    await call("PUT", `/api/mails/${id}`, { status: "scheduled", scheduled_at: inAnHour() });
    expect(mailRow(id)).toMatchObject({ status: "draft", scheduled_at: null });
  });
});

describe("unscheduling", () => {
  it("puts a scheduled mail back to draft, and its job then stops itself", async () => {
    const id = await readyMail();
    const at = inAnHour();
    await call("POST", `/api/mails/${id}/send`, { scheduled_at: at });
    const res = await call("POST", `/api/mails/${id}/unschedule`);
    expect(res.status).toBe(200);
    expect(mailRow(id)).toMatchObject({ status: "draft", scheduled_at: null });

    const fired = await call("POST", "/api/jobs/send-mail", jobs[0].payload);
    expect(await fired.json()).toMatchObject({ ok: true, skipped: "not-scheduled" });
    expect(mailRow(id).status).toBe("draft");
  });

  it("says when there is nothing to cancel, or it is too late", async () => {
    const id = await readyMail();
    expect((await call("POST", `/api/mails/${id}/unschedule`)).status).toBe(409);
    db.prepare(`UPDATE mails SET status = 'sending' WHERE id = ?`).run(id);
    const late = await call("POST", `/api/mails/${id}/unschedule`);
    expect(late.status).toBe(409);
    expect(((await late.json()) as any).error).toMatch(/sending/);
    expect((await call("POST", `/api/mails/9999/unschedule`)).status).toBe(404);
  });
});

describe("a scheduled job that finds the mail can't go out", () => {
  it("puts the mail back to draft with the reason, and answers 200 so the queue stops retrying", async () => {
    const id = await readyMail();
    const at = inAnHour();
    await call("POST", `/api/mails/${id}/send`, { scheduled_at: at });
    domains = []; // the sending domain lost its verification since

    const fired = await call("POST", "/api/jobs/send-mail", jobs[0].payload);
    expect(fired.status).toBe(200);
    const row = mailRow(id);
    expect(row).toMatchObject({ status: "draft", scheduled_at: null });
    expect(row.send_error).toMatch(/^Scheduled send didn't go out: example\.com isn't a verified sending domain/);
  });

  // Without a key of its own the app resolves Resend through the org's
  // connection, and a failed lookup also comes back as "no provider".
  it("retries, and keeps the schedule, when the sending backend can't be resolved", async () => {
    const id = await readyMail();
    const at = inAnHour();
    await call("POST", `/api/mails/${id}/send`, { scheduled_at: at });
    delete env.RESEND_API_KEY; // the connection lookup now hits the stub's 500
    const fired = await call("POST", "/api/jobs/send-mail", jobs[0].payload);
    expect(fired.status).toBe(503);
    expect(mailRow(id)).toMatchObject({ status: "scheduled", scheduled_at: at, send_error: null });
  });

  it("answers 200 for a mail deleted since it was scheduled", async () => {
    const id = await readyMail();
    await call("POST", `/api/mails/${id}/send`, { scheduled_at: inAnHour() });
    await call("DELETE", `/api/mails/${id}`);
    const fired = await call("POST", "/api/jobs/send-mail", jobs[0].payload);
    expect(fired.status).toBe(200);
    expect(await fired.json()).toMatchObject({ skipped: "not-found" });
  });

  it("clears the reason when the issue is scheduled again", async () => {
    const id = await readyMail();
    await call("POST", `/api/mails/${id}/send`, { scheduled_at: inAnHour() });
    domains = [];
    await call("POST", "/api/jobs/send-mail", jobs[0].payload);
    domains = [{ name: "example.com", status: "verified" }];
    await call("POST", `/api/mails/${id}/send`, { scheduled_at: inAnHour() });
    expect(mailRow(id)).toMatchObject({ status: "scheduled", send_error: null });
  });

  it("still sends when everything is in order", async () => {
    const id = await readyMail(2);
    await call("POST", `/api/mails/${id}/send`, { scheduled_at: inAnHour() });
    const fired = await call("POST", "/api/jobs/send-mail", jobs[0].payload);
    expect(fired.status).toBe(200);
    expect(mailRow(id).status).toBe("sent");
  });
});
