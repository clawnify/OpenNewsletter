// Deleting a template never changes how a mail looks: mails that showed it
// get a copy of its design first, and mails with their own design are untouched.
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index";
import { DEFAULT_DESIGN } from "../shared/design";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

// Blocks that print the primary and link colours, so a preview shows the look.
const COLOURED = [
  { id: "b1", type: "button", text: "Read it", href: "https://example.com/a" },
  { id: "t1", type: "text", md: "See [the notes](https://example.com/b)." },
];
const HOUSE = { ...DEFAULT_DESIGN, colors: { ...DEFAULT_DESIGN.colors, primary: "#0F766E", link: "#0F766E" } };

let db: any;
let env: Record<string, unknown>;
// Runs once, just before the next statement whose SQL contains `on.sql`.
let between: { sql: string; run: () => void } | null = null;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  env = {
    STORAGE: {
      async query(sql: string, params: unknown[] = []) {
        if (between && sql.includes(between.sql)) {
          between.run();
          between = null;
        }
        const stmt = db.prepare(sql);
        if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: stmt.all(...(params as any[])) };
        stmt.run(...(params as any[]));
        return { rows: [] };
      },
    },
  };
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const json = async (method: string, path: string, body?: unknown): Promise<any> => (await call(method, path, body)).json();
const preview = async (id: number) => (await call("GET", `/api/mails/${id}/preview`)).text();

describe("DELETE /api/templates/:slug", () => {
  it("leaves every mail that used it looking exactly as it did", async () => {
    await call("POST", "/api/templates", { name: "House", slug: "house", design: HOUSE });
    const follows = await json("POST", "/api/mails", { template_slug: "house" });
    const own = await json("POST", "/api/mails", { template_slug: "house" });
    await call("PUT", `/api/mails/${follows.id}`, { blocks: COLOURED });
    await call("PUT", `/api/mails/${own.id}`, { blocks: COLOURED, design: { ...HOUSE, typography: { ...HOUSE.typography, titleSize: 44 } } });
    const before = [await preview(follows.id), await preview(own.id)];
    expect(before[0]).toContain("#0F766E");

    expect((await call("DELETE", "/api/templates/house")).status).toBe(200);

    expect([await preview(follows.id), await preview(own.id)]).toEqual(before);
    expect((await json("GET", `/api/mails/${own.id}`)).design.typography.titleSize).toBe(44);
  });

  it("leaves mails on other templates alone", async () => {
    await call("POST", "/api/templates", { name: "House", slug: "house", design: HOUSE });
    const other = await json("POST", "/api/mails", { template_slug: "classic-editorial" });
    await call("DELETE", "/api/templates/house");
    expect((await json("GET", `/api/mails/${other.id}`)).design).toBeNull();
  });
});

describe("PUT /api/mails/:id", () => {
  it("doesn't write the design back when the save doesn't carry one", async () => {
    const m = await json("POST", "/api/mails", { template_slug: "classic-editorial" });
    // A template delete copies its design in after this save read the row.
    between = { sql: "UPDATE mails SET eyebrow", run: () => db.prepare(`UPDATE mails SET design = ? WHERE id = ?`).run(JSON.stringify(HOUSE), m.id) };
    await call("PUT", `/api/mails/${m.id}`, { ...m, design: undefined, design_mobile: undefined, preheader: "Hi" });
    const saved = await json("GET", `/api/mails/${m.id}`);
    expect(saved.preheader).toBe("Hi");
    expect(saved.design.colors.primary).toBe("#0F766E");
  });
});
