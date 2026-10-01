// Routes against real SQLite behind a storage binding that, like the
// app-supervisor's, returns rows and nothing else: no insert id, no counts.
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index";
import { DEFAULT_DESIGN } from "../shared/design";

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
