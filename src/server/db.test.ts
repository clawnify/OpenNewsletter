// The boot-time column migration: "already exists" is fine, anything else is reported.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDB, addColumns } from "./db";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

let failNext: string | null = null;
beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
  initDB({
    STORAGE: {
      async query(sql: string) {
        if (failNext && sql.includes(failNext)) throw new Error("D1_ERROR: Network connection lost.");
        db.prepare(sql).run();
        return { rows: [] };
      },
    },
  });
  failNext = null;
});

describe("addColumns", () => {
  it("adds a missing column, then treats the repeat as done", async () => {
    expect(await addColumns([`ALTER TABLE t ADD COLUMN a TEXT`])).toBe(true);
    expect(await addColumns([`ALTER TABLE t ADD COLUMN a TEXT`])).toBe(true);
  });

  it("reports any other failure so the caller retries, and still runs the rest", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    failNext = "COLUMN a ";
    expect(await addColumns([`ALTER TABLE t ADD COLUMN a TEXT`, `ALTER TABLE t ADD COLUMN b TEXT`])).toBe(false);
    expect(log).toHaveBeenCalled();
    failNext = null;
    expect(await addColumns([`ALTER TABLE t ADD COLUMN a TEXT`, `ALTER TABLE t ADD COLUMN b TEXT`])).toBe(true);
    log.mockRestore();
  });
});
