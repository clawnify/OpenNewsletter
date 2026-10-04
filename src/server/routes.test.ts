// Routes against real SQLite behind a storage binding that, like the
// app-supervisor's, returns rows and nothing else: no insert id, no counts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index";
import { DEFAULT_DESIGN } from "../shared/design";
import { BUILTIN_TEMPLATES } from "../shared/templates";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

let env: Record<string, unknown>;
beforeEach(() => {
  const db = new DatabaseSync(":memory:");
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
  // The app seeds built-in templates once per process, and each test here has a fresh database.
  for (const t of BUILTIN_TEMPLATES) {
    db.prepare(`INSERT OR IGNORE INTO templates (slug, name, description, design, skeleton, builtin) VALUES (?, ?, ?, ?, ?, 1)`)
      .run(t.slug, t.name, t.description, JSON.stringify(t.design), JSON.stringify(t.skeleton));
  }
});

type Reply = { status: number; json(): Promise<any> };
const call = async (method: string, path: string, body?: unknown): Promise<Reply> =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

describe("POST /api/templates", () => {
  it("keeps an explicit slug as given, and refuses it once taken", async () => {
    const first = await call("POST", "/api/templates", { name: "House", slug: "house-style", design: DEFAULT_DESIGN });
    expect(first.status).toBe(201);
    expect((await first.json()).slug).toBe("house-style");
    const again = await call("POST", "/api/templates", { name: "House 2", slug: "house-style", design: DEFAULT_DESIGN });
    expect(again.status).toBe(409);
  });

  it("suffixes a slug derived from the name, so two templates with one name both save", async () => {
    const a = await (await call("POST", "/api/templates", { name: "Weekly Digest", design: DEFAULT_DESIGN })).json();
    const b = await (await call("POST", "/api/templates", { name: "Weekly Digest", design: DEFAULT_DESIGN })).json();
    expect(a.slug).toMatch(/^weekly-digest-[a-z0-9]{1,4}$/);
    expect(b.slug).not.toBe(a.slug);
  });

  it("rejects a slug that isn't lowercase kebab case, or isn't a string", async () => {
    expect((await call("POST", "/api/templates", { name: "X", slug: "House Style", design: DEFAULT_DESIGN })).status).toBe(400);
    expect((await call("POST", "/api/templates", { name: "X", slug: 123, design: DEFAULT_DESIGN })).status).toBe(400);
  });
});

describe("mails", () => {
  it("creates a mail on a binding that reports no insert id", async () => {
    const res = await call("POST", "/api/mails", {});
    expect(res.status).toBe(201);
    const mail = await res.json();
    expect(mail.id).toBeGreaterThan(0);
    expect(mail.blocks.length).toBeGreaterThan(0);
  });

  it("saves the preview text", async () => {
    const { id } = await (await call("POST", "/api/mails", {})).json();
    const saved = await (await call("PUT", `/api/mails/${id}`, { preheader: "Three fixes this week" })).json();
    expect(saved.preheader).toBe("Three fixes this week");
    expect((await (await call("GET", `/api/mails/${id}`)).json()).preheader).toBe("Three fixes this week");
  });
});

describe("templates make the mail they show", () => {
  const h1s = (mail: { blocks: { type: string; level?: number }[] }) => mail.blocks.filter((b) => b.type === "heading" && b.level === 1).length;

  it("a template saved from a mail creates that mail again, with one title", async () => {
    const original = await (await call("POST", "/api/mails", { template_slug: "classic-editorial" })).json();
    expect(h1s(original)).toBe(1);
    const saved = await (await call("POST", "/api/templates", { name: "Mine", slug: "mine", from_mail_id: original.id })).json();
    const copy = await (await call("POST", "/api/mails", { template_slug: saved.slug })).json();
    expect(h1s(copy)).toBe(1);
    expect(copy.blocks.map((b: { type: string }) => b.type)).toEqual(original.blocks.map((b: { type: string }) => b.type));
  });

  it("a template saved from a mail with no title doesn't gain the masthead it never showed", async () => {
    const original = await (await call("POST", "/api/mails", { template_slug: "classic-editorial" })).json();
    const body = [{ id: "x", type: "text", md: "Just a note." }];
    await call("PUT", `/api/mails/${original.id}`, { blocks: body });
    const saved = await (await call("POST", "/api/templates", { name: "Note", slug: "note", from_mail_id: original.id })).json();
    const copy = await (await call("POST", "/api/mails", { template_slug: saved.slug })).json();
    expect(copy.blocks.map((b: { type: string; md?: string }) => [b.type, b.md])).toEqual([["text", "Just a note."]]);
  });
});

describe("GET /api/templates/:slug/preview", () => {
  it("renders the mail the template creates, with a sample reader and no scripts allowed", async () => {
    const res = await app.request("/api/templates/classic-editorial/preview", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    const mail = await (await call("POST", "/api/mails", { template_slug: "classic-editorial" })).json();
    const title = mail.blocks.find((b: { type: string; level?: number }) => b.type === "heading" && b.level === 1).text;
    expect(html).toContain(title);
  });

  it("is a 404 for an unknown template", async () => {
    expect((await app.request("/api/templates/nope/preview", {}, env)).status).toBe(404);
  });
});

describe("boot migration", () => {
  it("upgrades an install from before the deliveries table without reporting a failed column", async () => {
    vi.resetModules();
    const fresh = (await import("./index")).default;
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    db.exec(`DROP TABLE deliveries`);
    const old = {
      STORAGE: {
        async query(sql: string, params: unknown[] = []) {
          const stmt = db.prepare(sql);
          if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: stmt.all(...(params as any[])) };
          stmt.run(...(params as any[]));
          return { rows: [] };
        },
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await fresh.request("/api/settings", {}, old)).status).toBe(200);
    expect(log.mock.calls.filter((c) => c[0] === "[migrate]")).toEqual([]);
    log.mockRestore();
    const cols = db.prepare(`PRAGMA table_info(deliveries)`).all().map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["first_name", "last_name"]));
  });
});
