import { Hono } from "hono";
import type { CredentialBinding } from "@clawnify/connections";
import { initDB, query, get, run } from "./db";
import { getEmailProvider } from "./providers";
import { generateDraft, generateField, completeText, rewriteBatch } from "./ai";
import { renderEmailHtml } from "./render";
import { BUILTIN_TEMPLATES } from "../shared/templates";
import { DEFAULT_DESIGN, withDefaults, type DesignTokens } from "../shared/design";
import { markdownToBlocks, blocksToMarkdown, blockId, eyebrowBlock, titleBlock, deckBlock, bylineBlock, deriveTitle } from "../shared/blocks";
import { streamNewsletterChat, buildHintsContext, type ChatContext, type Hint } from "./agent";
import type { Block, Mail, Settings, Template } from "../shared/types";

type Env = {
  Bindings: {
    DB: D1Database;
    UPLOADS?: R2Bucket;
    // Injected by Clawnify when the org connects Resend in the dashboard —
    // read via @clawnify/connections. RESEND_API_KEY wins as a BYO fallback.
    CREDENTIALS?: CredentialBinding;
    CLAWNIFY_ORG_ID?: string;
    RESEND_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    NEWSLETTER_MODEL?: string;
    GITHUB_TOKEN?: string;
  };
};

const app = new Hono<Env>();

// Surface real error messages instead of Hono's opaque "Internal Server
// Error" so the dashboard toast (and logs) say what actually failed.
app.onError((err, c) => {
  console.error("[api error]", err);
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
});

let seeded = false;
async function ensureSeed() {
  if (seeded) return;
  for (const t of BUILTIN_TEMPLATES) {
    await run(
      `INSERT OR IGNORE INTO templates (slug, name, description, design, skeleton, builtin)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [t.slug, t.name, t.description, JSON.stringify(t.design), JSON.stringify(t.skeleton)],
    );
  }
  await run(`INSERT OR IGNORE INTO settings (id) VALUES (1)`);
  // Additive migrations for DBs created before these columns existed.
  for (const sql of [
    `ALTER TABLE mails ADD COLUMN design_mobile TEXT`,
    `ALTER TABLE mails ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE mails ADD COLUMN conversation TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE settings ADD COLUMN logo TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE settings ADD COLUMN senders TEXT NOT NULL DEFAULT '[]'`,
  ]) {
    try {
      await run(sql);
    } catch {
      /* column already exists */
    }
  }
  seeded = true;
}

app.use("*", async (c, next) => {
  initDB(c.env);
  await ensureSeed();
  await next();
});

// ── AI assistant chat (editor left sidebar) ──────────────────────────
// Streams a UI-message response for the editor's `useChat`. The editing tools
// carry no server `execute` — they stream to the browser and mutate the live
// mail there, so every edit lands on the editor's undo stack.
app.post("/api/chat", async (c) => {
  const env = c.env;
  if (!env.OPENROUTER_API_KEY) return c.json({ error: "Connect OPENROUTER_API_KEY to use the assistant." }, 400);
  const body = await c.req.json<{ messages: Parameters<typeof streamNewsletterChat>[0]["messages"]; context?: ChatContext; hints?: Hint[] }>();
  const hintsText = await buildHintsContext(body.hints, env);
  const repos = (body.hints || []).filter((h) => h.kind === "github" && h.repo).map((h) => h.repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, ""));
  return streamNewsletterChat({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.NEWSLETTER_MODEL,
    messages: body.messages,
    context: body.context,
    hintsText,
    github: repos.length ? { repos, token: env.GITHUB_TOKEN } : undefined,
    readers: {
      list: async () => {
        const rows = await query<{ id: number; title: string; status: string }>("SELECT id, title, status FROM mails ORDER BY updated_at DESC LIMIT 30");
        return rows.map((r) => ({ id: r.id, title: r.title, status: r.status }));
      },
      read: async (id) => {
        const row = await get<{ title: string; blocks: string }>("SELECT title, blocks FROM mails WHERE id = ?", [id]);
        if (!row) return null;
        let blocks: Block[] = [];
        try { blocks = JSON.parse(row.blocks || "[]"); } catch { /* corrupt blocks → empty */ }
        return { title: row.title, markdown: blocksToMarkdown(blocks) };
      },
    },
  });
});

// The assistant conversation is stored 1:1 with each mail so it reloads with
// the newsletter. Opaque blob of AI-SDK UI messages — only this client reads it.
app.get("/api/mails/:id/conversation", async (c) => {
  const row = await get<{ conversation: string }>("SELECT conversation FROM mails WHERE id = ?", [Number(c.req.param("id"))]);
  let messages: unknown[] = [];
  try { messages = JSON.parse(row?.conversation || "[]"); } catch { /* corrupt → empty */ }
  return c.json({ messages });
});

app.put("/api/mails/:id/conversation", async (c) => {
  const { messages } = await c.req.json<{ messages: unknown[] }>();
  await run("UPDATE mails SET conversation = ? WHERE id = ?", [JSON.stringify(messages || []), Number(c.req.param("id"))]);
  return c.json({ ok: true });
});

// ── helpers ──────────────────────────────────────────────────────────

function envOf(c: any): Record<string, string> {
  return c.env as unknown as Record<string, string>;
}

function parseMail(row: any): Mail {
  let blocks: Block[] = [];
  try {
    blocks = row.blocks ? JSON.parse(row.blocks) : [];
  } catch {
    blocks = [];
  }
  return {
    ...row,
    blocks,
    design: row.design ? JSON.parse(row.design) : null,
    design_mobile: row.design_mobile ? JSON.parse(row.design_mobile) : null,
  };
}

async function getSettings(): Promise<Settings> {
  const row = await get<any>("SELECT * FROM settings WHERE id = 1");
  let senders: Settings["senders"] = [];
  try { senders = JSON.parse(row?.senders || "[]"); } catch { /* corrupt → empty */ }
  return {
    publication_name: row?.publication_name || "My Newsletter",
    logo: row?.logo || "",
    from_name: row?.from_name || "",
    from_email: row?.from_email || "",
    senders,
    default_audience_id: row?.default_audience_id || null,
    footer_text: row?.footer_text || "",
  };
}

async function templateDesign(slug: string | null): Promise<DesignTokens> {
  if (!slug) return DEFAULT_DESIGN;
  const t = await get<any>("SELECT design FROM templates WHERE slug = ?", [slug]);
  if (!t) return DEFAULT_DESIGN;
  try {
    return withDefaults(JSON.parse(t.design));
  } catch {
    return DEFAULT_DESIGN;
  }
}

/** Effective tokens: mail override → template → default. */
async function resolveDesign(mail: Mail): Promise<DesignTokens> {
  if (mail.design) return withDefaults(mail.design);
  return templateDesign(mail.template_slug);
}

function fromAddress(s: Settings): string | null {
  if (!s.from_email) return null;
  return s.from_name ? `${s.from_name} <${s.from_email}>` : s.from_email;
}

// ── status ───────────────────────────────────────────────────────────

app.get("/api/status", async (c) => {
  const env = envOf(c);
  const provider = await getEmailProvider(c.env);
  let audiences: any[] = [];
  if (provider) {
    try {
      audiences = await provider.listAudiences();
    } catch (e) {
      // Connected but listing failed (e.g. no segments yet) — surface empty.
      audiences = [];
    }
  }
  return c.json({
    resend_connected: !!provider,
    ai_available: !!env.OPENROUTER_API_KEY,
    github_connected: !!env.GITHUB_TOKEN,
    audiences,
  });
});

// Repos the GITHUB_TOKEN can see — lets the chat offer a picker instead of
// making the user type owner/repo. Empty (not an error) when no token is set.
app.get("/api/github/repos", async (c) => {
  const token = c.env.GITHUB_TOKEN;
  if (!token) return c.json({ connected: false, repos: [] });
  const r = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", {
    headers: { "User-Agent": "open-newsletter", Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return c.json({ connected: true, repos: [], error: `GitHub ${r.status}` });
  const data = (await r.json()) as Array<{ full_name: string; private: boolean }>;
  return c.json({ connected: true, repos: data.map((d) => ({ full_name: d.full_name, private: d.private })) });
});

// ── settings ─────────────────────────────────────────────────────────

app.get("/api/settings", async (c) => c.json(await getSettings()));

app.put("/api/settings", async (c) => {
  const b = await c.req.json<Partial<Settings>>();
  const cur = await getSettings();
  const next = { ...cur, ...b };
  await run(
    `UPDATE settings SET publication_name = ?, logo = ?, from_name = ?, from_email = ?, senders = ?, default_audience_id = ?, footer_text = ? WHERE id = 1`,
    [next.publication_name, next.logo, next.from_name, next.from_email, JSON.stringify(next.senders || []), next.default_audience_id, next.footer_text],
  );
  return c.json(await getSettings());
});

// Verified sending domains + the user's saved senders, for the Senders UI.
app.get("/api/senders", async (c) => {
  const p = await provider(c);
  let domains: { name: string; status: string }[] = [];
  if (p) {
    try { domains = await p.listDomains(); } catch { domains = []; }
  }
  const s = await getSettings();
  return c.json({ domains, senders: s.senders });
});

// ── templates ────────────────────────────────────────────────────────

app.get("/api/templates", async (c) => {
  const rows = await query<any>("SELECT * FROM templates ORDER BY builtin DESC, name ASC");
  return c.json(
    rows.map((r) => ({
      ...r,
      builtin: !!r.builtin,
      design: JSON.parse(r.design),
      skeleton: JSON.parse(r.skeleton),
    })),
  );
});

app.post("/api/templates", async (c) => {
  const b = await c.req.json<Partial<Template> & { from_mail_id?: number }>();
  if (!b.name?.trim()) return c.json({ error: "Name required" }, 400);

  let design = b.design;
  let skeleton = b.skeleton;
  // Save-as from an existing mail: snapshot its design + content.
  if (b.from_mail_id) {
    const row = await get<any>("SELECT * FROM mails WHERE id = ?", [b.from_mail_id]);
    if (row) {
      const mail = parseMail(row);
      design = design || (await resolveDesign(mail));
      skeleton = skeleton || {
        eyebrow: mail.eyebrow,
        title: mail.title,
        subtitle: mail.subtitle,
        byline_name: mail.byline_name,
        byline_date: mail.byline_date,
        feature_image: mail.feature_image,
        blocks: mail.blocks,
      };
    }
  }
  if (!design) return c.json({ error: "design required" }, 400);

  const slug =
    (b.slug?.trim() || b.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")) +
    "-" +
    Math.random().toString(36).slice(2, 6);

  await run(
    `INSERT INTO templates (slug, name, description, design, skeleton, builtin) VALUES (?, ?, ?, ?, ?, 0)`,
    [slug, b.name.trim(), b.description || "", JSON.stringify(design), JSON.stringify(skeleton || {})],
  );
  const row = await get<any>("SELECT * FROM templates WHERE slug = ?", [slug]);
  return c.json({ ...row, builtin: false, design: JSON.parse(row.design), skeleton: JSON.parse(row.skeleton) }, 201);
});

app.delete("/api/templates/:slug", async (c) => {
  const slug = c.req.param("slug");
  const t = await get<any>("SELECT builtin FROM templates WHERE slug = ?", [slug]);
  if (!t) return c.json({ error: "Not found" }, 404);
  if (t.builtin) return c.json({ error: "Cannot delete a built-in template" }, 400);
  await run("DELETE FROM templates WHERE slug = ?", [slug]);
  return c.json({ ok: true });
});

// ── mails ───────────────────────────────────────────────────────────

app.get("/api/mails", async (c) => {
  const rows = await query<any>("SELECT * FROM mails ORDER BY updated_at DESC");
  return c.json(rows.map(parseMail));
});

app.get("/api/mails/:id", async (c) => {
  const row = await get<any>("SELECT * FROM mails WHERE id = ?", [Number(c.req.param("id"))]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(parseMail(row));
});

app.post("/api/mails", async (c) => {
  const b = await c.req.json<{ template_slug?: string }>().catch(() => ({}) as any);
  const slug = b.template_slug || "classic-editorial";
  const t = await get<any>("SELECT * FROM templates WHERE slug = ?", [slug]);
  const skeleton = t ? JSON.parse(t.skeleton) : {};
  const s = await getSettings();

  // Masthead is now a set of blocks at the top of the body.
  const eyebrow = skeleton.eyebrow || s.publication_name?.toUpperCase() || "";
  const title = skeleton.title || "Untitled";
  const subtitle = skeleton.subtitle || "";
  const masthead: Block[] = [];
  if (eyebrow) masthead.push(eyebrowBlock(eyebrow));
  masthead.push(titleBlock(title));
  if (subtitle) masthead.push(deckBlock(subtitle));
  if (skeleton.byline_name) masthead.push(bylineBlock(skeleton.byline_date ? `${skeleton.byline_name} · ${skeleton.byline_date}` : skeleton.byline_name));
  if (skeleton.feature_image) masthead.push({ id: blockId(), type: "image", src: skeleton.feature_image, alt: "", caption: "", href: "" });
  const blocks: Block[] = [...masthead, ...((skeleton.blocks as Block[]) || [])];

  const result = await run(
    `INSERT INTO mails (eyebrow, title, subtitle, byline_name, byline_date, feature_image, blocks, template_slug, audience_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [eyebrow, title, subtitle, skeleton.byline_name || "", skeleton.byline_date || "", skeleton.feature_image || "", JSON.stringify(blocks), slug, s.default_audience_id],
  );
  const row = await get<any>("SELECT * FROM mails WHERE id = ?", [result.lastInsertRowid]);
  return c.json(parseMail(row), 201);
});

app.put("/api/mails/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<Partial<Mail>>();

  const fields: Record<string, unknown> = {
    eyebrow: b.eyebrow ?? existing.eyebrow,
    title: b.title ?? existing.title,
    subtitle: b.subtitle ?? existing.subtitle,
    byline_name: b.byline_name ?? existing.byline_name,
    byline_date: b.byline_date ?? existing.byline_date,
    feature_image: b.feature_image ?? existing.feature_image,
    blocks: b.blocks !== undefined ? JSON.stringify(b.blocks) : existing.blocks,
    design: b.design !== undefined ? (b.design ? JSON.stringify(b.design) : null) : existing.design,
    design_mobile:
      b.design_mobile !== undefined
        ? b.design_mobile && Object.keys(b.design_mobile).length
          ? JSON.stringify(b.design_mobile)
          : null
        : existing.design_mobile,
    template_slug: b.template_slug ?? existing.template_slug,
    audience_id: b.audience_id !== undefined ? b.audience_id : existing.audience_id,
    status: b.status ?? existing.status,
    scheduled_at: b.scheduled_at !== undefined ? b.scheduled_at : existing.scheduled_at,
  };

  // The email subject (and list title) is derived from the blocks, since the
  // title is now just a display-heading block.
  if (b.blocks !== undefined) fields.title = deriveTitle(b.blocks);

  await run(
    `UPDATE mails SET eyebrow=?, title=?, subtitle=?, byline_name=?, byline_date=?, feature_image=?, blocks=?, design=?, design_mobile=?, template_slug=?, audience_id=?, status=?, scheduled_at=?, updated_at=datetime('now') WHERE id=?`,
    [
      fields.eyebrow, fields.title, fields.subtitle, fields.byline_name, fields.byline_date,
      fields.feature_image, fields.blocks, fields.design, fields.design_mobile, fields.template_slug, fields.audience_id,
      fields.status, fields.scheduled_at, id,
    ],
  );
  const row = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
  return c.json(parseMail(row));
});

app.delete("/api/mails/:id", async (c) => {
  await run("DELETE FROM mails WHERE id = ?", [Number(c.req.param("id"))]);
  return c.json({ ok: true });
});

// ── generation ───────────────────────────────────────────────────────

app.post("/api/mails/:id/generate", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  const env = envOf(c);
  if (!env.OPENROUTER_API_KEY) return c.json({ error: "AI generation unavailable: connect an OpenRouter API key." }, 400);

  const { prompt, target } = await c.req.json<{
    prompt: string;
    target?: "all" | "title" | "subtitle" | "eyebrow" | "body";
  }>();
  if (!prompt?.trim()) return c.json({ error: "Prompt required" }, 400);
  const s = await getSettings();
  const mail = parseMail(row);
  const bodyMd = blocksToMarkdown(mail.blocks);
  const ctx = { title: mail.title, subtitle: mail.subtitle, eyebrow: mail.eyebrow, body_md: bodyMd };

  try {
    if (!target || target === "all") {
      const draft = await generateDraft(env, {
        prompt: prompt.trim(),
        publication: s.publication_name,
        current: mail.blocks.length ? { title: mail.title, body_md: bodyMd } : null,
      });
      // Rebuild masthead (styled text/heading) + body from the draft.
      const blocks: Block[] = [];
      if (draft.eyebrow) blocks.push(eyebrowBlock(draft.eyebrow));
      blocks.push(titleBlock(draft.title));
      if (draft.subtitle) blocks.push(deckBlock(draft.subtitle));
      blocks.push(...markdownToBlocks(draft.body_md));
      await run(
        `UPDATE mails SET eyebrow=?, title=?, subtitle=?, blocks=?, updated_at=datetime('now') WHERE id=?`,
        [draft.eyebrow || mail.eyebrow, draft.title, draft.subtitle, JSON.stringify(blocks), id],
      );
    } else {
      const value = await generateField(env, { field: target, prompt: prompt.trim(), publication: s.publication_name, context: ctx });
      if (target === "body") {
        await run(`UPDATE mails SET blocks=?, updated_at=datetime('now') WHERE id=?`, [
          JSON.stringify(markdownToBlocks(value)),
          id,
        ]);
      } else {
        await run(`UPDATE mails SET ${target}=?, updated_at=datetime('now') WHERE id=?`, [value, id]);
      }
    }
    const updated = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
    return c.json(parseMail(updated));
  } catch (e: any) {
    return c.json({ error: e?.message || "Generation failed" }, 502);
  }
});

// Rewrite a single block with AI (selective generation at block level).
app.post("/api/mails/:id/blocks/:blockId/rewrite", async (c) => {
  const id = Number(c.req.param("id"));
  const blockId = c.req.param("blockId");
  const env = envOf(c);
  if (!env.OPENROUTER_API_KEY) return c.json({ error: "AI generation unavailable: connect an OpenRouter API key." }, 400);
  const { prompt } = await c.req.json<{ prompt: string }>();
  if (!prompt?.trim()) return c.json({ error: "Prompt required" }, 400);

  const row = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  const mail = parseMail(row);
  const block = mail.blocks.find((b) => b.id === blockId);
  if (!block) return c.json({ error: "Block not found" }, 404);

  const system =
    "You are an expert newsletter editor. Rewrite the given content per the instruction. Output ONLY the replacement content, no preamble, no quotes, no code fences.";
  const ctx = `Mail title: ${mail.title}\n`;

  try {
    let patched = block;
    if (block.type === "text") {
      const md = await completeText(env, system + " Output Markdown (one or more short paragraphs).", `${ctx}Current:\n${block.md}\n\nInstruction: ${prompt}`);
      patched = { ...block, md };
    } else if (block.type === "heading" || block.type === "quote" || block.type === "button") {
      const text = await completeText(env, system + " Output a single short line of plain text.", `${ctx}Current: ${block.text}\n\nInstruction: ${prompt}`);
      patched = { ...block, text: text.replace(/^["']|["']$/g, "") };
    } else if (block.type === "list") {
      const out = await completeText(env, system + " Output a plain list, one item per line, no bullets or numbers.", `${ctx}Current:\n${block.items.join("\n")}\n\nInstruction: ${prompt}`);
      patched = { ...block, items: out.split("\n").map((s) => s.replace(/^[-*\d.\s]+/, "").trim()).filter(Boolean) };
    } else {
      return c.json({ error: `Can't AI-rewrite a ${block.type} block` }, 400);
    }
    const blocks = mail.blocks.map((b) => (b.id === blockId ? patched : b));
    await run(`UPDATE mails SET blocks=?, updated_at=datetime('now') WHERE id=?`, [JSON.stringify(blocks), id]);
    const updated = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
    return c.json(parseMail(updated));
  } catch (e: any) {
    return c.json({ error: e?.message || "Rewrite failed" }, 502);
  }
});

// Rewrite several selected blocks at once (multi-select AI), structured per block.
app.post("/api/mails/:id/blocks/rewrite-batch", async (c) => {
  const id = Number(c.req.param("id"));
  const env = envOf(c);
  if (!env.OPENROUTER_API_KEY) return c.json({ error: "AI generation unavailable: connect an OpenRouter API key." }, 400);
  const { ids, prompt } = await c.req.json<{ ids: string[]; prompt: string }>();
  if (!prompt?.trim()) return c.json({ error: "Prompt required" }, 400);
  if (!ids?.length) return c.json({ error: "Select at least one block" }, 400);

  const row = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  const mail = parseMail(row);
  const s = await getSettings();

  const sel = mail.blocks.filter((b) => ids.includes(b.id));
  const sections = sel
    .map((b) => {
      if (b.type === "text") return { id: b.id, type: b.type, current: b.md };
      if (b.type === "heading" || b.type === "quote" || b.type === "button") return { id: b.id, type: b.type, current: b.text };
      if (b.type === "list") return { id: b.id, type: b.type, current: b.items.join("\n") };
      return null;
    })
    .filter(Boolean) as { id: string; type: string; current: string }[];
  if (!sections.length) return c.json({ error: "Selected blocks can't be AI-rewritten" }, 400);

  try {
    const out = await rewriteBatch(env, prompt.trim(), sections, s.publication_name);
    const blocks = mail.blocks.map((b) => {
      const v = out[b.id];
      if (v == null) return b;
      if (b.type === "text") return { ...b, md: v };
      if (b.type === "heading" || b.type === "quote" || b.type === "button") return { ...b, text: String(v).replace(/^["']|["']$/g, "") };
      if (b.type === "list") return { ...b, items: String(v).split("\n").map((x) => x.replace(/^[-*\d.\s]+/, "").trim()).filter(Boolean) };
      return b;
    });
    await run(`UPDATE mails SET blocks=?, updated_at=datetime('now') WHERE id=?`, [JSON.stringify(blocks), id]);
    const updated = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
    return c.json(parseMail(updated));
  } catch (e: any) {
    return c.json({ error: e?.message || "Rewrite failed" }, 502);
  }
});

// ── preview (server-rendered email HTML) ─────────────────────────────

app.get("/api/mails/:id/preview", async (c) => {
  const row = await get<any>("SELECT * FROM mails WHERE id = ?", [Number(c.req.param("id"))]);
  if (!row) return c.json({ error: "Not found" }, 404);
  const mail = parseMail(row);
  const design = await resolveDesign(mail);
  const html = renderEmailHtml(mail, design, await getSettings(), { mobile: mail.design_mobile });
  return c.html(html);
});

// ── image uploads (R2) ───────────────────────────────────────────────

app.post("/api/upload", async (c) => {
  const bucket = c.env.UPLOADS;
  if (!bucket) return c.json({ error: "Storage not configured" }, 400);
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
  if (!file.type.startsWith("image/")) return c.json({ error: "Images only" }, 400);

  const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await bucket.put(`uploads/${key}`, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  const origin = new URL(c.req.url).origin;
  return c.json({ url: `${origin}/api/uploads/${key}` });
});

// Public: serve an uploaded image (email clients fetch these directly).
app.get("/api/uploads/:key", async (c) => {
  const bucket = c.env.UPLOADS;
  if (!bucket) return c.notFound();
  const obj = await bucket.get(`uploads/${c.req.param("key")}`);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

// ── audiences (Resend segments) ──────────────────────────────────────

function provider(c: any) {
  return getEmailProvider(c.env);
}

app.get("/api/audiences", async (c) => {
  const p = await provider(c);
  if (!p) return c.json({ error: "Resend not connected" }, 400);
  try {
    return c.json(await p.listAudiences());
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed to list audiences" }, 502);
  }
});

app.get("/api/audiences/:id/contacts", async (c) => {
  const p = await provider(c);
  if (!p) return c.json({ error: "Resend not connected" }, 400);
  try {
    return c.json(await p.listContacts(c.req.param("id")));
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed to list contacts" }, 502);
  }
});

app.post("/api/audiences/:id/contacts", async (c) => {
  const p = await provider(c);
  if (!p) return c.json({ error: "Resend not connected" }, 400);
  const b = await c.req.json<{ email: string; first_name?: string; last_name?: string }>();
  if (!b.email?.trim()) return c.json({ error: "Email required" }, 400);
  try {
    const contact = await p.addContact(c.req.param("id"), b);
    return c.json(contact, 201);
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed to add contact" }, 502);
  }
});

app.delete("/api/audiences/:id/contacts/:contactId", async (c) => {
  const p = await provider(c);
  if (!p) return c.json({ error: "Resend not connected" }, 400);
  try {
    await p.removeContact(c.req.param("id"), c.req.param("contactId"));
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed to remove contact" }, 502);
  }
});

// ── send ─────────────────────────────────────────────────────────────

app.post("/api/mails/:id/test", async (c) => {
  const id = Number(c.req.param("id"));
  const p = await provider(c);
  if (!p) return c.json({ error: "Resend not connected" }, 400);
  const { to, from: fromOverride } = await c.req.json<{ to: string; from?: string }>();
  if (!to?.trim()) return c.json({ error: "Recipient email required" }, 400);

  const row = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  const mail = parseMail(row);
  const s = await getSettings();
  const from = fromOverride?.includes("@") ? fromOverride : fromAddress(s);
  if (!from) return c.json({ error: "Pick a sender, or set a from name and email in Settings first." }, 400);

  const html = renderEmailHtml(mail, await resolveDesign(mail), s);
  try {
    const r = await p.sendEmail({ from, to: to.trim(), subject: mail.title, html });
    return c.json({ ok: true, id: r.id });
  } catch (e: any) {
    return c.json({ error: e?.message || "Test send failed" }, 502);
  }
});

app.post("/api/mails/:id/send", async (c) => {
  const id = Number(c.req.param("id"));
  const p = await provider(c);
  if (!p) return c.json({ error: "Resend not connected" }, 400);
  const { scheduled_at, from: fromOverride } = await c.req.json<{ scheduled_at?: string; from?: string }>().catch(() => ({}) as any);

  const row = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
  if (!row) return c.json({ error: "Not found" }, 404);
  const mail = parseMail(row);
  if (!mail.audience_id) return c.json({ error: "Pick an audience before sending." }, 400);

  const s = await getSettings();
  const from = fromOverride?.includes("@") ? fromOverride : fromAddress(s);
  if (!from) return c.json({ error: "Pick a sender, or set a from name and email in Settings first." }, 400);

  const html = renderEmailHtml(mail, await resolveDesign(mail), s);
  try {
    const b = await p.createBroadcast({ audienceId: mail.audience_id, from, subject: mail.title, html });
    await p.sendBroadcast(b.id, scheduled_at || null);
    const status = scheduled_at ? "scheduled" : "sent";
    await run(
      `UPDATE mails SET status=?, broadcast_id=?, scheduled_at=?, sent_at=?, updated_at=datetime('now') WHERE id=?`,
      [status, b.id, scheduled_at || null, scheduled_at ? null : new Date().toISOString(), id],
    );
    const updated = await get<any>("SELECT * FROM mails WHERE id = ?", [id]);
    return c.json({ ok: true, broadcast_id: b.id, mail: parseMail(updated) });
  } catch (e: any) {
    return c.json({ error: e?.message || "Send failed" }, 502);
  }
});

export default app;
