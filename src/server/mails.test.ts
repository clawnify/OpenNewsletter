// Mail routes against real SQLite through a storage binding that, like the
// preview lane's, returns rows but no insert id or change count.
import { beforeEach, expect, it } from "vitest";
import worker from "./index";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

let env: any;
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

it("creates a mail when the storage binding reports no insert id", async () => {
  const req = (body: object) =>
    worker.fetch(new Request("http://app/api/mails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, {} as any);
  const a = await req({});
  expect(a.status).toBe(201);
  const first = (await a.json()) as any;
  expect(first.id).toBeGreaterThan(0);
  expect(first.title).toBeTruthy();
  const second = (await (await req({})).json()) as any;
  expect(second.id).toBe(first.id + 1);
});
