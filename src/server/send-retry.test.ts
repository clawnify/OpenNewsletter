// A failed send retried with nothing changed must snapshot the same thing:
// beginSend compares snapshots, and a different one gives up on every
// delivery whose first attempt had an unknown outcome ("may have been delivered").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

let db: any;
let env: Record<string, unknown>;
let batchStatus = 401;
beforeEach(() => {
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
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/domains")) return Response.json({ data: [{ name: "example.com", status: "verified" }] });
    if (String(url).endsWith("/emails/batch")) {
      if (batchStatus !== 200) return Response.json({ name: "invalid_api_key", message: "API key is invalid" }, { status: batchStatus });
      return Response.json({ data: (JSON.parse(String(init?.body)) as unknown[]).map((_, i) => ({ id: `msg_${i}` })) });
    }
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const call = async (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

describe("retrying a failed send", () => {
  it("snapshots the same mail as the first attempt when nothing was edited", async () => {
    await call("PUT", "/api/settings", { from_name: "Ann", from_email: "ann@example.com" });
    const m: any = await (await call("POST", "/api/mails", {})).json();
    const audience = ((await (await call("GET", "/api/audiences")).json()) as any)[0].id;
    await call("PUT", `/api/mails/${m.id}`, { audience_id: audience });
    db.prepare(`INSERT INTO contacts (id, audience_id, email, status, consent_source) VALUES ('c1', ?, 'r@example.com', 'subscribed', 'manual')`).run(audience);

    await call("POST", `/api/mails/${m.id}/send`, {});
    const first = db.prepare(`SELECT status, send_snapshot FROM mails WHERE id = ?`).get(m.id);
    expect(first.status).toBe("failed");

    await call("POST", `/api/mails/${m.id}/send`, {});
    const second = db.prepare(`SELECT send_snapshot FROM mails WHERE id = ?`).get(m.id);
    expect(second.send_snapshot).toBe(first.send_snapshot);
    expect(JSON.parse(second.send_snapshot).mail).not.toHaveProperty("send_snapshot");
  });
});
