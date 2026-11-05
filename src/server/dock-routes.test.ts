// The routes the Clawnify sidebar chat works an issue through: discovery, the
// one context read (sources included), the all-or-nothing edit, sources in
// Settings, and a bounded issue list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index";
import { BUILTIN_TEMPLATES } from "../shared/templates";
import { clearActivityCache } from "./sources";

declare const process: { getBuiltinModule(id: string): any };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const { readFileSync } = process.getBuiltinModule("node:fs");

let env: Record<string, unknown>;
beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  // Added on boot by ensureSeed, which runs once per process, not per test database.
  db.exec(`ALTER TABLE settings ADD COLUMN senders TEXT NOT NULL DEFAULT '[]'`);
  db.exec(`INSERT INTO settings (id) VALUES (1)`);
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
  for (const t of BUILTIN_TEMPLATES) {
    db.prepare(`INSERT OR IGNORE INTO templates (slug, name, description, design, skeleton, builtin) VALUES (?, ?, ?, ?, ?, 1)`)
      .run(t.slug, t.name, t.description, JSON.stringify(t.design), JSON.stringify(t.skeleton));
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearActivityCache();
});

type Reply = { status: number; json(): Promise<any>; text(): Promise<string> };
const call = async (method: string, path: string, body?: unknown): Promise<Reply> =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

/** GitHub stand-in: commits per repo, a search, and anything else 404. */
function fakeGitHub(commits: Record<string, string[]>) {
  const fetchMock = vi.fn(async (url: string) => {
    const m = url.match(/api\.github\.com\/repos\/([^/]+\/[^/]+)\/commits/);
    if (m && commits[m[1]]) {
      return new Response(JSON.stringify(commits[m[1]].map((msg) => ({ commit: { message: msg, author: { date: "2026-11-01T00:00:00Z" } } }))));
    }
    if (url.includes("/search/commits")) return new Response(JSON.stringify({ items: [{ commit: { message: "Fix the signup form\n\nbody", author: { date: "2026-10-30T00:00:00Z" } } }] }));
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function newIssue() {
  const mail = await (await call("POST", "/api/mails", {})).json();
  return mail as { id: number; blocks: { id: string; type: string }[]; title: string };
}

describe("discovery", () => {
  it("/llms.txt lists the routes the chat needs", async () => {
    const r = await call("GET", "/llms.txt");
    expect(r.status).toBe(200);
    const text = await r.text();
    for (const route of ["GET /api/mails/{id}/context", "POST /api/mails/{id}/edit", "GET /api/sources/search", "POST /api/upload"]) expect(text).toContain(route);
  });

  it("a wrong /api route answers with where to look", async () => {
    const r = await call("GET", "/api/nope");
    expect(r.status).toBe(404);
    expect((await r.json()).hint).toContain("/llms.txt");
  });
});

describe("POST /api/mails/:id/edit", () => {
  it("applies ops in order and returns the new outline", async () => {
    const mail = await newIssue();
    const firstText = mail.blocks.find((b) => b.type === "text")!;
    const r = await call("POST", `/api/mails/${mail.id}/edit`, {
      ops: [
        { op: "set_title", input: { title: "Shipped this week" } },
        { op: "edit_block", input: { block_id: firstText.id, text: "Three fixes went out." } },
      ],
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.results).toHaveLength(2);
    expect(body.subject).toBe("Shipped this week"); // the block edit in the same save kept it
    expect(body.outline).toContain(`[${firstText.id}] text: Three fixes went out.`);
    const saved = await (await call("GET", `/api/mails/${mail.id}`)).json();
    expect(saved.title).toBe("Shipped this week");
  });

  it("is all or nothing: one bad op saves none", async () => {
    const mail = await newIssue();
    const firstText = mail.blocks.find((b) => b.type === "text")!;
    const r = await call("POST", `/api/mails/${mail.id}/edit`, {
      ops: [
        { op: "edit_block", input: { block_id: firstText.id, text: "Changed" } },
        { op: "remove_block", input: { block_id: "b_missing" } },
      ],
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/^Op 2 \(remove_block\): No block with id b_missing\. Nothing was saved\.$/);
    const saved = await (await call("GET", `/api/mails/${mail.id}`)).json();
    expect(saved.blocks).toEqual((mail as any).blocks);
  });

  it("an op name from Object's prototype is an unknown op, not a crash", async () => {
    const mail = await newIssue();
    for (const op of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect((await call("POST", `/api/mails/${mail.id}/edit`, { ops: [{ op, input: {} }] })).status).toBe(400);
    }
  });

  it("validates every op's input before applying any", async () => {
    const mail = await newIssue();
    const bad = await call("POST", `/api/mails/${mail.id}/edit`, { ops: [{ op: "style_block", input: { block_id: "x", padding: 500 } }] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("padding");
    expect((await call("POST", `/api/mails/${mail.id}/edit`, { ops: [{ op: "send", input: {} }] })).status).toBe(400);
    expect((await call("POST", `/api/mails/${mail.id}/edit`, { ops: [] })).status).toBe(400);
    expect((await call("POST", `/api/mails/${mail.id}/edit`, { ops: Array(51).fill({ op: "set_title", input: { title: "x" } }) })).status).toBe(400);
    expect((await call("POST", `/api/mails/99999/edit`, { ops: [{ op: "set_title", input: { title: "x" } }] })).status).toBe(404);
  });

  it("a design op stores only usable token values", async () => {
    const mail = await newIssue();
    const r = await call("POST", `/api/mails/${mail.id}/edit`, {
      ops: [
        { op: "set_design", input: { key: "colors.primary", value: "#112233" } },
        { op: "set_design", input: { key: "layout.buttonRadius", value: 12 } },
      ],
    });
    expect(r.status).toBe(200);
    const saved = await (await call("GET", `/api/mails/${mail.id}`)).json();
    expect(saved.design.colors.primary).toBe("#112233"); // the second design op built on the first
    expect(saved.design.layout.buttonRadius).toBe(12);
    // A value the design can't use is refused, and the one before it stays.
    const evil = await call("POST", `/api/mails/${mail.id}/edit`, { ops: [{ op: "set_design", input: { key: "colors.primary", value: "red}</style><script>" } }] });
    expect(evil.status).toBe(400);
    expect((await (await call("GET", `/api/mails/${mail.id}`)).json()).design.colors.primary).toBe("#112233");
  });
});

describe("sources", () => {
  it("Settings keeps clean, deduplicated GitHub repos, at most ten", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: "github", repo: `acme/r${i}` }));
    const r = await call("PUT", "/api/settings", {
      sources: [{ kind: "github", repo: "https://github.com/Acme/Site.git" }, { kind: "github", repo: "acme/site" }, { kind: "gitlab", repo: "x/y" }, { kind: "github", repo: "not a repo" }, ...many],
    });
    const s = await r.json();
    expect(s.sources[0]).toEqual({ kind: "github", repo: "Acme/Site" });
    expect(s.sources.filter((x: any) => x.repo.toLowerCase() === "acme/site")).toHaveLength(1);
    expect(s.sources).toHaveLength(10);
  });

  it("the context read always carries the sources' recent commits", async () => {
    fakeGitHub({ "acme/site": ["Add dark mode\n\nlong body", "Fix footer links"] });
    await call("PUT", "/api/settings", { sources: [{ kind: "github", repo: "acme/site" }] });
    const mail = await newIssue();
    const ctx = await (await call("GET", `/api/mails/${mail.id}/context`)).json();
    expect(ctx.sources).toEqual([{ kind: "github", repo: "acme/site", recent_commits: ["Add dark mode (2026-11-01)", "Fix footer links (2026-11-01)"] }]);
    expect(ctx.outline).toContain("heading");
    expect(ctx.edit.ops).toContain("edit_block");
    expect(ctx.automation).toBeNull();
  });

  it("a source GitHub refuses says why instead of failing the read", async () => {
    fakeGitHub({});
    await call("PUT", "/api/settings", { sources: [{ kind: "github", repo: "acme/private" }] });
    const r = await call("GET", "/api/sources");
    expect(r.status).toBe(200);
    expect((await r.json()).sources[0].error).toContain("GITHUB_TOKEN");
  });

  it("search only reaches repos that are sources", async () => {
    fakeGitHub({});
    await call("PUT", "/api/settings", { sources: [{ kind: "github", repo: "acme/site" }] });
    expect((await call("GET", "/api/sources/search?repo=evil/repo&q=fix")).status).toBe(400);
    expect((await call("GET", "/api/sources/search?repo=acme/site")).status).toBe(400);
    const ok = await (await call("GET", "/api/sources/search?repo=acme/site&q=signup")).json();
    expect(ok.commits).toEqual(["Fix the signup form (2026-10-30)"]);
  });

  it("search words can't add qualifiers that widen it past the source", async () => {
    const fetchMock = fakeGitHub({});
    await call("PUT", "/api/settings", { sources: [{ kind: "github", repo: "acme/site" }] });
    await call("GET", `/api/sources/search?repo=acme/site&q=${encodeURIComponent("fix repo:acme/private-secrets org:acme")}`);
    const url = decodeURIComponent(String(fetchMock.mock.calls.at(-1)![0]));
    expect(url).toContain("q=repo:acme/site fix&");
    expect(url).not.toContain("private-secrets");
    expect((await call("GET", `/api/sources/search?repo=acme/site&q=${encodeURIComponent("repo:x/y")}`)).status).toBe(400);
  });

  it("recent activity is cached for a few minutes, so reads don't spend GitHub's hourly limit", async () => {
    const fetchMock = fakeGitHub({ "acme/site": ["One"] });
    await call("PUT", "/api/settings", { sources: [{ kind: "github", repo: "acme/site" }] });
    await call("GET", "/api/sources");
    await call("GET", "/api/sources");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/commits?")).length).toBe(1);
  });
});

describe("two writers on one issue", () => {
  it("a save based on an older copy is refused with the current one, so it can merge instead of erase", async () => {
    const mail = await newIssue();
    const fresh = await (await call("GET", `/api/mails/${mail.id}`)).json();
    // The chat edits the issue...
    expect((await call("POST", `/api/mails/${mail.id}/edit`, { ops: [{ op: "set_title", input: { title: "From the chat" } }] })).status).toBe(200);
    // ...then the editor saves from the copy it opened.
    const stale = await call("PUT", `/api/mails/${mail.id}`, { preheader: "From the editor", rev: fresh.rev });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.mail.title).toBe("From the chat");
    expect((await call("PUT", `/api/mails/${mail.id}`, { preheader: "From the editor", rev: body.mail.rev })).status).toBe(200);
    // A writer without a copy (no rev) still saves as before.
    expect((await call("PUT", `/api/mails/${mail.id}`, { preheader: "Plain" })).status).toBe(200);
  });
});

describe("GET /api/mails?summary=1", () => {
  it("is one bounded line per issue, a page at a time", async () => {
    for (let i = 0; i < 3; i++) await newIssue();
    const first = await (await call("GET", "/api/mails?summary=1&limit=2")).json();
    expect(first.mails).toHaveLength(2);
    expect(Object.keys(first.mails[0]).sort()).toEqual(["flow", "id", "scheduled_at", "sent_at", "status", "title", "updated_at"]);
    expect(first.next_offset).toBe(2);
    const rest = await (await call("GET", "/api/mails?summary=1&limit=2&offset=2")).json();
    expect(rest.mails).toHaveLength(1);
    expect(rest.next_offset).toBeNull();
    expect((await call("GET", "/api/mails?summary=1&limit=1.5&offset=0.5")).status).toBe(200);
  });
});
