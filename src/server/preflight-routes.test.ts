// The preflight route against the app as a whole, and the send precheck it
// shares its domain rule with.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clawnify/queue", () => ({ enqueueJob: async () => {}, verifyDelivery: async () => true }));

let app: typeof import("./index").default;

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

let db: any;
let env: Record<string, unknown>;
let domains: { id: string; name: string; status: string; click_tracking?: boolean }[];
let records: { record: string; status: string }[];
let dmarc: Record<string, string[]>;
let dnsDown: boolean;
beforeEach(async () => {
  vi.resetModules();
  app = (await import("./index")).default;
  domains = [{ id: "dom_1", name: "example.com", status: "verified" }];
  records = [{ record: "SPF", status: "verified" }, { record: "DKIM", status: "verified" }];
  dmarc = {};
  dnsDown = false;
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  env = {
    RESEND_API_KEY: "re_test",
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
    if (url.hostname === "cloudflare-dns.com") {
      if (dnsDown) return new Response("down", { status: 502 });
      const name = url.searchParams.get("name")!;
      const answers = (dmarc[name] || []).map((v) => ({ name, type: 16, data: `"${v}"` }));
      return Response.json({ Status: answers.length ? 0 : 3, Answer: answers.length ? answers : undefined });
    }
    if (url.pathname === "/domains") return Response.json({ data: domains });
    if (url.pathname === "/domains/dom_1") return Response.json({ id: "dom_1", records });
    if (url.pathname === "/emails/batch") {
      return Response.json({ data: (JSON.parse(String(init?.body)) as unknown[]).map((_, i) => ({ id: `msg_${i}` })) });
    }
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const ORIGIN = "https://news.apps.clawnify.com";
const call = async (method: string, path: string, body?: unknown) =>
  app.request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

async function readyMail() {
  await call("PUT", "/api/settings", { from_name: "Ann", from_email: "ann@example.com" });
  const m: any = await (await call("POST", "/api/mails", {})).json();
  const audience = ((await (await call("GET", "/api/audiences")).json()) as any)[0].id;
  await call("PUT", `/api/mails/${m.id}`, { audience_id: audience });
  db.prepare(`INSERT INTO contacts (id, audience_id, email, status, consent_source) VALUES ('c0', ?, 'r0@example.com', 'subscribed', 'manual')`).run(audience);
  return m.id as number;
}

const preflight = async (id: number, from?: string) => {
  const res = await call("GET", `/api/mails/${id}/preflight${from ? `?from=${encodeURIComponent(from)}` : ""}`);
  return Object.fromEntries(((await res.json()) as any).checks.map((c: any) => [c.id, c]));
};

describe("sending from a partially verified domain", () => {
  // Resend: partially_verified sends normally (receiving pending, or one of two sending records).
  it("is allowed by the send route", async () => {
    domains[0].status = "partially_verified";
    const id = await readyMail();
    const res = await call("POST", `/api/mails/${id}/send`, {});
    expect(res.status).toBe(200);
    expect(db.prepare(`SELECT status FROM mails WHERE id = ?`).get(id).status).toBe("sent");
  });

  it("is still refused while Resend hasn't verified it", async () => {
    domains[0].status = "pending";
    const id = await readyMail();
    expect((await call("POST", `/api/mails/${id}/send`, {})).status).toBe(400);
  });
});

describe("GET /api/mails/:id/preflight", () => {
  it("passes a verified domain with DMARC, and a light email", async () => {
    dmarc["_dmarc.example.com"] = ["v=DMARC1; p=quarantine; rua=mailto:d@example.com"];
    const c = await preflight(await readyMail());
    expect(c.domain.level).toBe("ok");
    expect(c.dmarc).toMatchObject({ level: "ok", detail: expect.stringContaining("p=quarantine") });
    expect(c.size.level).toBe("ok");
    expect(c.images.level).toBe("ok");
  });

  it("checks the sender picked in the dialog, not only the default", async () => {
    const id = await readyMail();
    expect((await preflight(id, "Ann <ann@elsewhere.org>")).domain.level).toBe("fail");
  });

  it("gives the DMARC record to add when there is none", async () => {
    const c = await preflight(await readyMail(), "news@mail.example.com");
    expect(c.dmarc.level).toBe("warn");
    expect(c.dmarc.record).toEqual({ name: "_dmarc.example.com", type: "TXT", value: "v=DMARC1; p=none;" });
  });

  it("warns on a DKIM record Resend hasn't verified", async () => {
    domains[0].status = "partially_verified";
    records = [{ record: "SPF", status: "verified" }, { record: "DKIM", status: "failed" }];
    expect((await preflight(await readyMail())).domain.level).toBe("warn");
  });

  it("flags embedded images and a body Gmail would clip", async () => {
    const id = await readyMail();
    const huge = "word ".repeat(25_000);
    await call("PUT", `/api/mails/${id}`, {
      blocks: [
        { id: "i", type: "image", src: "data:image/png;base64,iVBORw0KGgo=", alt: "" },
        { id: "t", type: "text", md: huge },
      ],
    });
    const c = await preflight(id);
    expect(c.images.level).toBe("warn");
    expect(c.size.level).toBe("warn");
  });

  it("reports unknown, not a pass, when DNS or Resend can't be reached", async () => {
    dnsDown = true;
    domains = null as any;
    vi.stubGlobal("fetch", async (input: string) =>
      String(input).includes("cloudflare-dns.com") ? new Response("down", { status: 502 }) : new Response("down", { status: 503 }));
    const c = await preflight(await readyMail());
    expect(c.domain.level).toBe("unknown");
    expect(c.dmarc.level).toBe("unknown");
  });
});
