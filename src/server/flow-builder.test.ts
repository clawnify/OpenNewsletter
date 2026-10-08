// Building automations over HTTP: the library and blank starts, adding and
// removing steps, the trigger's list, and an automation's emails staying out
// of the issue workflow (never broadcast, never deleted from under a flow).
import { beforeEach, describe, expect, it, vi } from "vitest";

// The queued-send callback is signed; accept every delivery here.
vi.mock("@clawnify/queue", () => ({ enqueueJob: vi.fn(), verifyDelivery: vi.fn(async () => true) }));
const { default: app } = await import("./index");
import { BUILTIN_TEMPLATES } from "../shared/templates";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

let env: Record<string, unknown>;
let db: any;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  env = {
    STORAGE: {
      async query(sql: string, params: unknown[] = []) {
        const stmt = db.prepare(sql);
        if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: stmt.all(...(params as any[])) };
        stmt.run(...(params as any[]));
        return { rows: [] };
      },
    },
  };
  for (const t of BUILTIN_TEMPLATES) {
    db.prepare(`INSERT OR IGNORE INTO templates (slug, name, description, design, skeleton, builtin) VALUES (?, ?, ?, ?, ?, 1)`)
      .run(t.slug, t.name, t.description, JSON.stringify(t.design), JSON.stringify(t.skeleton));
  }
  db.prepare(`INSERT INTO audiences (id, name) VALUES ('aud_a', 'Readers'), ('aud_b', 'Customers')`).run();
});

type Reply = { status: number; json(): Promise<any> };
const call = async (method: string, path: string, body?: unknown): Promise<Reply> =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

/** Steps in chain order, from the entry. */
function chain(flow: { entry_step_id: string; steps: { id: string; kind: string; config: string; next_step_id: string | null }[] }) {
  const byId = new Map(flow.steps.map((s) => [s.id, s]));
  const out: { id: string; kind: string; config: any }[] = [];
  for (let id: string | null = flow.entry_step_id; id; id = byId.get(id)?.next_step_id ?? null) {
    const s = byId.get(id)!;
    out.push({ id: s.id, kind: s.kind, config: JSON.parse(s.config) });
  }
  return out;
}
const getFlow = async (id: string) => (await call("GET", `/api/flows/${id}`)).json();

describe("creating an automation", () => {
  it("the welcome series lands in order: email, 3 days, email, 4 days, email, End", async () => {
    const created = await (await call("POST", "/api/flows", { prebuilt: "welcome", audience_id: "aud_b" })).json();
    const flow = await getFlow(created.id);
    const steps = chain(flow);
    expect(steps.map((s) => s.kind)).toEqual(["email", "delay", "email", "delay", "email", "end"]);
    expect(steps.filter((s) => s.kind === "delay").map((s) => s.config.seconds)).toEqual([3 * 86400, 4 * 86400]);
    expect(JSON.parse(flow.trigger_config).audience_id).toBe("aud_b");
    const titles = await Promise.all(steps.filter((s) => s.kind === "email").map(async (s) => (await (await call("GET", `/api/mails/${s.config.mail_id}`)).json()).title));
    expect(titles).toEqual(["Welcome aboard", "Getting the most out of this", "One more thing"]);
    // Born blank: no sample article can go out under a real subject.
    expect(flow.issues.filter((i: any) => i.message === "This email is empty. Add some content.")).toHaveLength(3);
  });

  it("blank is the trigger and End, and can't be turned on until it has an email", async () => {
    const created = await (await call("POST", "/api/flows", { prebuilt: "blank" })).json();
    const flow = await getFlow(created.id);
    expect(chain(flow).map((s) => s.kind)).toEqual(["end"]);
    expect(flow.issues.map((i: any) => i.message)).toContain("Add an email before turning this on.");
    expect((await call("POST", `/api/flows/${created.id}/status`, { status: "live" })).status).toBe(400);
  });

  it("refuses a list that doesn't exist", async () => {
    expect((await call("POST", "/api/flows", { prebuilt: "blank", audience_id: "nope" })).status).toBe(400);
  });
});

describe("adding and removing steps", () => {
  it("adds an email after the trigger with no subject yet, so it shows as not ready", async () => {
    const { id } = await (await call("POST", "/api/flows", { prebuilt: "blank", audience_id: "aud_b" })).json();
    const step = await (await call("POST", `/api/flows/${id}/steps`, { after: null, kind: "email" })).json();
    const flow = await getFlow(id);
    expect(chain(flow).map((s) => s.kind)).toEqual(["email", "end"]);
    const mail = await (await call("GET", `/api/mails/${JSON.parse(step.config).mail_id}`)).json();
    expect(mail.title).toBe("");
    expect(mail.audience_id).toBe("aud_b");
    expect(flow.issues.find((i: any) => i.step_id === step.id)?.message).toBe("This email has no subject.");
    // A body with nothing to take a subject from saves as "Untitled": still no subject.
    await call("PUT", `/api/mails/${mail.id}`, { blocks: [{ id: "b1", type: "image", src: "https://example.com/a.png" }] });
    const again = await getFlow(id);
    expect(again.issues.find((i: any) => i.step_id === step.id)?.message).toBe("This email has no subject.");
  });

  it("adds a wait after a step, one day unless told otherwise, and refuses one out of range", async () => {
    const { id } = await (await call("POST", "/api/flows", { prebuilt: "welcome" })).json();
    const first = chain(await getFlow(id))[0];
    const wait = await (await call("POST", `/api/flows/${id}/steps`, { after: first.id, kind: "delay" })).json();
    expect(JSON.parse(wait.config).seconds).toBe(86400);
    expect(chain(await getFlow(id))[1].id).toBe(wait.id);
    expect((await call("POST", `/api/flows/${id}/steps`, { after: first.id, kind: "delay", seconds: 5 })).status).toBe(400);
    expect((await call("POST", `/api/flows/${id}/steps`, { after: first.id, kind: "split" })).status).toBe(400);
    // A stale client adding after a step that's gone: refused, and no stray email left behind.
    const before = (await (await call("GET", "/api/mails")).json()).length;
    expect((await call("POST", `/api/flows/${id}/steps`, { after: "step_gone", kind: "email" })).status).toBe(409);
    expect((await (await call("GET", "/api/mails")).json()).length).toBe(before);
    expect((await call("PATCH", `/api/flows/${id}/steps/${wait.id}`, { config: { seconds: 400 * 86400 } })).status).toBe(400);
    expect((await call("PATCH", `/api/flows/${id}/steps/${first.id}`, { config: { seconds: 60 } })).status).toBe(400);
  });

  it("removing an email step removes its email; End can't be removed", async () => {
    const { id } = await (await call("POST", "/api/flows", { prebuilt: "welcome" })).json();
    const steps = chain(await getFlow(id));
    const email = steps[0];
    expect((await call("DELETE", `/api/flows/${id}/steps/${email.id}`)).status).toBe(200);
    expect((await call("GET", `/api/mails/${email.config.mail_id}`)).status).toBe(404);
    expect(chain(await getFlow(id)).map((s) => s.kind)).toEqual(["delay", "email", "delay", "email", "end"]);
    expect((await call("DELETE", `/api/flows/${id}/steps/${steps.at(-1)!.id}`)).status).toBe(400);
  });
});

describe("an email's draft / live status", () => {
  it("going live needs a ready email; a wait has no status", async () => {
    const { id } = await (await call("POST", "/api/flows", { prebuilt: "blank" })).json();
    const step = await (await call("POST", `/api/flows/${id}/steps`, { after: null, kind: "email" })).json();
    const r = await call("PATCH", `/api/flows/${id}/steps/${step.id}`, { status: "live" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("This email has no subject.");
    expect((await call("PATCH", `/api/flows/${id}/steps/${step.id}`, { status: "draft" })).status).toBe(200);
    expect(chain(await getFlow(id))[0].config).toBeTruthy();
    const wait = await (await call("POST", `/api/flows/${id}/steps`, { after: step.id, kind: "delay" })).json();
    expect((await call("PATCH", `/api/flows/${id}/steps/${wait.id}`, { status: "live" })).status).toBe(400);
  });
});

describe("the trigger's list", () => {
  it("can change until someone has entered, then is fixed", async () => {
    const { id } = await (await call("POST", "/api/flows", { prebuilt: "welcome", audience_id: "aud_a" })).json();
    expect((await call("PATCH", `/api/flows/${id}`, { audience_id: "aud_b" })).status).toBe(200);
    expect(JSON.parse((await getFlow(id)).trigger_config).audience_id).toBe("aud_b");
    expect((await call("PATCH", `/api/flows/${id}`, { audience_id: "nope" })).status).toBe(400);

    db.prepare(`INSERT INTO contacts (id, audience_id, email, status) VALUES ('c1', 'aud_b', 'a@example.com', 'subscribed')`).run();
    db.prepare(`INSERT INTO flow_enrollments (id, flow_id, contact_id, state, current_step_id, due_at) VALUES ('e1', ?, 'c1', 'completed', 'x', 'now')`).run(id);
    expect((await getFlow(id)).entered).toBe(true);
    expect((await call("PATCH", `/api/flows/${id}`, { audience_id: "aud_a" })).status).toBe(409);
  });
});

describe("an automation's emails are not issues", () => {
  async function flowMail() {
    const { id } = await (await call("POST", "/api/flows", { prebuilt: "welcome" })).json();
    return { flowId: id, mailId: chain(await getFlow(id))[0].config.mail_id as number };
  }

  it("carry their automation in the list, the read and the save", async () => {
    const { flowId, mailId } = await flowMail();
    const issue = await (await call("POST", "/api/mails", {})).json();
    const list = await (await call("GET", "/api/mails")).json();
    expect(list.find((m: any) => m.id === mailId).flow).toEqual({ id: flowId, name: "Welcome series" });
    expect(list.find((m: any) => m.id === issue.id).flow).toBeNull();
    expect((await (await call("GET", `/api/mails/${mailId}`)).json()).flow?.id).toBe(flowId);
    expect((await (await call("PUT", `/api/mails/${mailId}`, { preheader: "hi" })).json()).flow?.id).toBe(flowId);
  });

  it("can't be sent or scheduled to the whole list", async () => {
    const { mailId } = await flowMail();
    expect((await call("POST", `/api/mails/${mailId}/send`, {})).status).toBe(409);
    expect((await call("POST", `/api/mails/${mailId}/send`, { scheduled_at: new Date(Date.now() + 3600e3).toISOString() })).status).toBe(409);
  });

  it("a queued send booked before this rule is skipped with 200, so the queue doesn't retry it", async () => {
    const { mailId } = await flowMail();
    db.prepare(`UPDATE mails SET status = 'scheduled', scheduled_at = ? WHERE id = ?`).run("2026-01-01T00:00:00.000Z", mailId);
    const r = await call("POST", "/api/jobs/send-mail", { mail_id: mailId, from: "a@example.com", scheduled_for: "2026-01-01T00:00:00.000Z" });
    expect(r.status).toBe(200);
    expect((await r.json()).skipped).toBe("automation-email");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM deliveries`).get().n).toBe(0);
  });

  it("can't be deleted from the mail list while the step uses it", async () => {
    const { mailId } = await flowMail();
    expect((await call("DELETE", `/api/mails/${mailId}`)).status).toBe(409);
    expect((await call("GET", `/api/mails/${mailId}`)).status).toBe(200);
  });
});
