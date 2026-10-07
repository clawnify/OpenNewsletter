// The sunset through the app's own routes: the ask is refused when the
// engagement data can't be trusted, it sends only to the inactive with a
// per-person keep link, and the keep link works.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clawnify/queue", () => ({ enqueueJob: async () => {}, verifyDelivery: async () => true }));

let app: typeof import("./index").default;

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

let db: any;
let env: Record<string, unknown>;
let sent: { to: string; html: string }[];
beforeEach(async () => {
  vi.resetModules();
  app = (await import("./index")).default;
  sent = [];
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  env = {
    RESEND_API_KEY: "re_test",
    RESEND_WEBHOOK_SECRET: "whsec_dGVzdA==",
    STORAGE: {
      async query(sql: string, params: unknown[] = []) {
        const stmt = db.prepare(sql);
        if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: stmt.all(...(params as any[])) };
        stmt.run(...(params as any[]));
        return { rows: [] };
      },
    },
  };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 3 });
    if (url.pathname === "/domains") return Response.json({ data: [{ id: "dom_1", name: "example.com", status: "verified" }] });
    if (url.pathname === "/domains/dom_1") return Response.json({ id: "dom_1", records: [] });
    if (url.pathname === "/emails/batch") {
      const msgs = JSON.parse(String(init?.body)) as { to: string[]; html: string }[];
      sent.push(...msgs.map((m) => ({ to: m.to[0], html: m.html })));
      return Response.json({ data: msgs.map((_, i) => ({ id: `msg_${sent.length}_${i}` })) });
    }
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const ORIGIN = "https://news.apps.clawnify.com";
const call = async (method: string, path: string, body?: unknown) =>
  app.request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

const DAY = 24 * 3600_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

/** An audience with one long-quiet reader ("quiet") and one who clicked last week ("reader"). */
async function audienceWithHistory() {
  await call("PUT", "/api/settings", { from_name: "Ann", from_email: "ann@example.com" });
  const aud = ((await (await call("GET", "/api/audiences")).json()) as any)[0].id as string;
  db.prepare(`UPDATE settings SET tracking_since = ?`).run(ago(400));
  for (const c of ["quiet", "reader"]) {
    db.prepare(`INSERT INTO contacts (id, audience_id, email, status, consent_source, created_at) VALUES (?, ?, ?, 'subscribed', 'manual', '2025-01-01 00:00:00')`).run(c, aud, `${c}@example.com`);
  }
  [200, 170, 140, 110, 95, 7].forEach((d, i) => {
    db.prepare(`INSERT INTO mails (id, title, audience_id, status, sent_at) VALUES (?, 'Issue', ?, 'sent', ?)`).run(100 + i, aud, ago(d));
    for (const c of ["quiet", "reader"]) {
      db.prepare(`INSERT INTO deliveries (id, mail_id, contact_id, email, batch, status, sent_at, clicked_at) VALUES (?, ?, ?, ?, 0, 'sent', ?, ?)`).run(
        `d${i}${c}`, 100 + i, c, `${c}@example.com`, ago(d), d === 7 && c === "reader" ? ago(d) : null,
      );
    }
  });
  db.prepare(`UPDATE contacts SET last_engaged_at = ? WHERE id = 'reader'`).run(ago(7));
  return aud;
}

describe("asking inactive subscribers", () => {
  it("counts them, writes the ask, and sends it only to them, each with their own keep link", async () => {
    const aud = await audienceWithHistory();
    const sum: any = await (await call("GET", `/api/audiences/${aud}/inactive`)).json();
    expect(sum).toMatchObject({ inactive: 1, blocked: null, days: 90, min_received: 5 });

    const res = await call("POST", `/api/audiences/${aud}/ask-inactive`, {});
    expect(res.status).toBe(201);
    const mail: any = await res.json();
    expect(mail).toMatchObject({ segment: "inactive", segment_days: 90, audience_id: aud });

    expect((await call("POST", `/api/mails/${mail.id}/send`, {})).status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["quiet@example.com"]);
    expect(sent[0].html).toContain(`${ORIGIN}/api/keep?c=quiet`);

    // While the ask runs, nobody is counted twice.
    expect(((await (await call("GET", `/api/audiences/${aud}/inactive`)).json()) as any)).toMatchObject({ inactive: 0, asked: 1 });
  });

  it("is refused without tracking, both when writing and when sending", async () => {
    const aud = await audienceWithHistory();
    const mail: any = await (await call("POST", `/api/audiences/${aud}/ask-inactive`, {})).json();
    delete env.RESEND_WEBHOOK_SECRET;
    const write = await call("POST", `/api/audiences/${aud}/ask-inactive`, {});
    expect(write.status).toBe(400);
    expect(((await write.json()) as any).error).toMatch(/delivery tracking/);
    expect((await call("POST", `/api/mails/${mail.id}/send`, {})).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("is refused when nobody is inactive", async () => {
    const aud = await audienceWithHistory();
    const mail: any = await (await call("POST", `/api/audiences/${aud}/ask-inactive`, {})).json();
    db.prepare(`UPDATE contacts SET last_engaged_at = ?`).run(ago(1));
    const res = await call("POST", `/api/mails/${mail.id}/send`, {});
    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
  });
});

describe("removal before every send", () => {
  it("an ordinary issue skips whoever an ask let go, even right after the once-a-minute check ran", async () => {
    const aud = await audienceWithHistory();
    // The ask went out 11 days ago, but this request's check ran while it wasn't due yet.
    db.prepare(`INSERT INTO mails (id, title, audience_id, status, sent_at, segment) VALUES (500, 'Ask', ?, 'sent', ?, 'inactive')`).run(aud, ago(1));
    db.prepare(`INSERT INTO deliveries (id, mail_id, contact_id, email, batch, status, sent_at) VALUES ('ask_q', 500, 'quiet', 'quiet@example.com', 0, 'sent', ?)`).run(ago(11));
    await call("GET", "/api/audiences");
    db.prepare(`UPDATE mails SET sent_at = ? WHERE id = 500`).run(ago(11));

    const m: any = await (await call("POST", "/api/mails", {})).json();
    await call("PUT", `/api/mails/${m.id}`, { audience_id: aud });
    expect((await call("POST", `/api/mails/${m.id}/send`, {})).status).toBe(200);
    expect(sent.map((x) => x.to)).toEqual(["reader@example.com"]);
    expect(db.prepare(`SELECT status, unsubscribe_reason FROM contacts WHERE id = 'quiet'`).get()).toEqual({ status: "unsubscribed", unsubscribe_reason: "inactive" });
  });
});

describe("the one-time engagement backfill", () => {
  it("failing never takes the app down, and keeps the ask refused until it succeeds", async () => {
    const aud = await audienceWithHistory();
    db.prepare(`UPDATE settings SET engagement_backfilled_at = NULL`).run();
    const real = (env.STORAGE as any).query;
    (env.STORAGE as any).query = async (sql: string, p: unknown[]) => {
      if (/GROUP BY contact_id/.test(sql)) throw new Error("D1_ERROR: query timed out");
      return real(sql, p);
    };
    vi.resetModules();
    app = (await import("./index")).default;
    expect((await call("GET", "/api/audiences")).status).toBe(200);
    const sum: any = await (await call("GET", `/api/audiences/${aud}/inactive`)).json();
    expect(sum.blocked).toMatch(/past opens and clicks/);
    expect((await call("POST", `/api/audiences/${aud}/ask-inactive`, {})).status).toBe(400);
  });
});

describe("GET /api/keep", () => {
  it("keeps the reader and says so; an unknown id is refused", async () => {
    const aud = await audienceWithHistory();
    const res = await call("GET", `/api/keep?c=quiet`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("still subscribed");
    expect(db.prepare(`SELECT last_engaged_at FROM contacts WHERE id = 'quiet'`).get().last_engaged_at).not.toBeNull();
    expect(((await (await call("GET", `/api/audiences/${aud}/inactive`)).json()) as any).inactive).toBe(0);
    expect((await call("GET", `/api/keep?c=nobody`)).status).toBe(400);
  });

  it("is a public route", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../clawnify.json", import.meta.url), "utf8"));
    expect(manifest.api.public_routes).toContainEqual({ path: "/api/keep", methods: ["GET"] });
  });
});
