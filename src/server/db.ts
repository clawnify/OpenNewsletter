/**
 * Database access. The worker is bound to a D1 database in production and a
 * compatible storage binding in preview; `@clawnify/db` detects which is
 * present and exposes one `query` / `get` / `run` API (params passed as an
 * array). This module re-exports that API and the app's D1 binding type.
 */
export type DB = D1Database;
import { run } from "@clawnify/db";
export { initDB, query, get, run } from "@clawnify/db";

/**
 * Run additive `ALTER TABLE ... ADD COLUMN` statements for databases created
 * before a column existed. "duplicate column" is the expected answer on every
 * boot after the first and is ignored. Any other failure (a timeout, a typo)
 * is logged and makes this return false, so the caller retries on the next
 * request instead of carrying on without the column.
 */
export async function addColumns(statements: string[]): Promise<boolean> {
  let ok = true;
  for (const sql of statements) {
    try {
      await run(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/duplicate column/i.test(message)) continue;
      console.error("[migrate]", sql, message);
      ok = false;
    }
  }
  return ok;
}
