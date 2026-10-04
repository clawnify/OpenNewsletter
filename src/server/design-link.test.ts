// A mail's design is its changes from its template, nothing more: a template
// change reaches every token the mail left alone, deleting a template keeps
// each mail's look, and a sent issue keeps the look it went out with.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESIGN, layerTokens, withDefaults } from "../shared/design";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

// Blocks that print the primary and link colours, so a preview shows both.
const COLOURED = [
  { id: "b1", type: "button", text: "Read it", href: "https://example.com/a" },
  { id: "t1", type: "text", md: "See [the notes](https://example.com/b)." },
];
const HOUSE = { ...DEFAULT_DESIGN, colors: { ...DEFAULT_DESIGN.colors, primary: "#0F766E", link: "#0F766E" } };

/** A fresh database (schema.sql, then `setup`) and a fresh app module, so each test boots once. */
async function boot(setup?: (db: any) => void) {
  vi.resetModules();
  const app = (await import("./index")).default;
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  setup?.(db);
  const env: Record<string, unknown> = {
    STORAGE: {
      async query(sql: string, params: unknown[] = []) {
        const stmt = db.prepare(sql);
        if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: stmt.all(...(params as any[])) };
        stmt.run(...(params as any[]));
        return { rows: [] };
      },
    },
  };
  const call = async (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const json = async (method: string, path: string, body?: unknown): Promise<any> => (await call(method, path, body)).json();
  const row = (id: number) => db.prepare(`SELECT * FROM mails WHERE id = ?`).get(id) as any;
  const preview = async (id: number) => (await call("GET", `/api/mails/${id}/preview`)).text();
  return { db, env, call, json, row, preview };
}

afterEach(() => vi.unstubAllGlobals());

describe("a mail stores only what it changed", () => {
  it("keeps one changed token, whether the caller sent all tokens or just that one", async () => {
    const { json, call, row } = await boot();
    await call("POST", "/api/templates", { name: "House", slug: "house", design: HOUSE });
    const a = await json("POST", "/api/mails", { template_slug: "house" });
    const b = await json("POST", "/api/mails", { template_slug: "house" });

    const full = withDefaults({ ...HOUSE, typography: { ...HOUSE.typography, titleSize: 44 } });
    expect((await json("PUT", `/api/mails/${a.id}`, { design: full })).design).toEqual({ typography: { titleSize: 44 } });
    expect((await json("PUT", `/api/mails/${b.id}`, { design: { typography: { titleSize: 44 } } })).design).toEqual({ typography: { titleSize: 44 } });
    expect(row(a.id).design_v).toBe(2);
  });

  it("stores null when nothing differs, and drops keys tokens don't have", async () => {
    const { json, call } = await boot();
    await call("POST", "/api/templates", { name: "House", slug: "house", design: HOUSE });
    const m = await json("POST", "/api/mails", { template_slug: "house" });
    expect((await json("PUT", `/api/mails/${m.id}`, { design: HOUSE })).design).toBeNull();
    expect((await json("PUT", `/api/mails/${m.id}`, { design: { colors: { nope: "#000", primary: "#111111" } } })).design).toEqual({ colors: { primary: "#111111" } });
  });

  it("follows its template on every token it left alone", async () => {
    const { json, call, db, preview } = await boot();
    await call("POST", "/api/templates", { name: "House", slug: "house", design: HOUSE });
    const m = await json("POST", "/api/mails", { template_slug: "house" });
    await call("PUT", `/api/mails/${m.id}`, { blocks: COLOURED, design: { colors: { link: "#7C3AED" } } });

    const recoloured = { ...HOUSE, colors: { ...HOUSE.colors, primary: "#B45309" } };
    db.prepare(`UPDATE templates SET design = ? WHERE slug = 'house'`).run(JSON.stringify(recoloured));
    const html = await preview(m.id);
    expect(html).toContain("#B45309"); // the template's new primary
    expect(html).toContain("#7C3AED"); // the mail's own link colour
    expect(html).not.toContain("#0F766E");
  });
});

describe("deleting a template", () => {
  it("leaves every mail on it looking exactly as it did, detached", async () => {
    const { json, call, row, preview } = await boot();
    await call("POST", "/api/templates", { name: "House", slug: "house", design: HOUSE });
    const untouched = await json("POST", "/api/mails", { template_slug: "house" });
    const touched = await json("POST", "/api/mails", { template_slug: "house" });
    await call("PUT", `/api/mails/${untouched.id}`, { blocks: COLOURED });
    await call("PUT", `/api/mails/${touched.id}`, { blocks: COLOURED, design: { typography: { titleSize: 44 } } });
    const before = [await preview(untouched.id), await preview(touched.id)];

    expect((await call("DELETE", "/api/templates/house")).status).toBe(200);

    expect(before[0]).toContain("#0F766E");
    expect([await preview(untouched.id), await preview(touched.id)]).toEqual(before);
    expect(row(untouched.id).template_slug).toBeNull();
    expect(JSON.parse(row(touched.id).design)).toMatchObject({ colors: { primary: "#0F766E" }, typography: { titleSize: 44 } });
  });
});

describe("boot conversion of old full copies", () => {
  const legacy = (db: any) => {
    db.prepare(`INSERT INTO templates (slug, name, description, design, skeleton, builtin) VALUES ('house', 'House', '', ?, '{}', 0)`).run(JSON.stringify(HOUSE));
    // A full copy taken when the design was first touched, with one change.
    const copy = { ...HOUSE, typography: { ...HOUSE.typography, titleSize: 44 } };
    db.prepare(`INSERT INTO mails (id, title, design, template_slug) VALUES (1, 'Draft', ?, 'house')`).run(JSON.stringify(copy));
    // A partial override an agent wrote, which the old code layered on the DEFAULT, not the template.
    db.prepare(`INSERT INTO mails (id, title, design, template_slug) VALUES (2, 'Agent', ?, 'house')`).run(JSON.stringify({ colors: { link: "#7C3AED" } }));
  };

  it("keeps each draft's look and stores only its changes from the template, once", async () => {
    const { row, preview, call, env } = await boot(legacy);
    await call("GET", "/api/settings");
    // What the old code rendered: the full copy as is, and the agent's partial on the default.
    const copy = { ...HOUSE, typography: { ...HOUSE.typography, titleSize: 44 } };
    expect(layerTokens(HOUSE, JSON.parse(row(1).design))).toEqual(copy);
    expect(layerTokens(HOUSE, JSON.parse(row(2).design))).toEqual(withDefaults({ colors: { link: "#7C3AED" } } as any));
    expect(JSON.parse(row(1).design)).toEqual({ typography: { titleSize: 44 } });
    expect([row(1).design_v, row(2).design_v]).toEqual([2, 2]);
    const first = [await preview(1), await preview(2)];

    // A second boot on the same database changes nothing.
    vi.resetModules();
    const again = (await import("./index")).default;
    await again.request("/api/settings", {}, env);
    expect(JSON.parse(row(1).design)).toEqual({ typography: { titleSize: 44 } });
    expect([await preview(1), await preview(2)]).toEqual(first);
  });

  it("detaches a sent issue with the look in its send snapshot", async () => {
    const sentWith = { ...HOUSE, colors: { ...HOUSE.colors, primary: "#B91C1C" } };
    const { row, call } = await boot((db) => {
      legacy(db);
      db.prepare(`INSERT INTO mails (id, title, template_slug, status, send_snapshot) VALUES (3, 'Sent', 'house', 'sent', ?)`).run(
        JSON.stringify({ mail: {}, design: sentWith, settings: {}, from: "a@b.c", origin: "https://x", renderer: 2 }),
      );
    });
    await call("GET", "/api/settings");
    const r = row(3);
    expect(r.template_slug).toBeNull();
    expect(layerTokens(DEFAULT_DESIGN, JSON.parse(r.design))).toEqual(sentWith);
  });
});

describe("sending", () => {
  it("detaches the issue first, so it keeps the look it went out with", async () => {
    const { json, call, row, env, db } = await boot();
    env.RESEND_API_KEY = "re_test";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/domains")) return Response.json({ data: [{ name: "example.com", status: "verified" }] });
      if (String(url).endsWith("/emails/batch")) {
        const sent = JSON.parse(String(init?.body)) as unknown[];
        return Response.json({ data: sent.map((_, i) => ({ id: `msg_${i}` })) });
      }
      return new Response("unexpected", { status: 500 });
    });
    await call("PUT", "/api/settings", { from_name: "Ann", from_email: "ann@example.com" });
    await call("POST", "/api/templates", { name: "House", slug: "house", design: HOUSE });
    const m = await json("POST", "/api/mails", { template_slug: "house" });
    await call("PUT", `/api/mails/${m.id}`, { blocks: COLOURED, design: { colors: { link: "#7C3AED" } } });
    const audience = (await json("GET", "/api/audiences"))[0].id;
    db.prepare(`INSERT INTO contacts (id, audience_id, email, status, consent_source) VALUES ('c1', ?, 'r@example.com', 'subscribed', 'manual')`).run(audience);
    await call("PUT", `/api/mails/${m.id}`, { audience_id: audience });

    const res = await call("POST", `/api/mails/${m.id}/send`, {});
    expect(res.status).toBe(200);
    const r = row(m.id);
    expect(r.template_slug).toBeNull();
    const look = layerTokens(DEFAULT_DESIGN, JSON.parse(r.design));
    expect(look.colors).toMatchObject({ primary: "#0F766E", link: "#7C3AED" });
    // The snapshot holds the detached mail, so a retry snapshots the same thing.
    const snap = JSON.parse(r.send_snapshot);
    expect(snap.mail.template_slug).toBeNull();
    expect(snap.design).toEqual(look);
  });
});
