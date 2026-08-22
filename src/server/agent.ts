/**
 * The newsletter assistant — an AI SDK agent that drives the editor through
 * conversation. OpenRouter is the model provider. The editing tools have no
 * `execute`: the model emits them as tool-calls that stream to the browser and
 * are applied to the live mail state there (so edits ride the editor's undo
 * stack and the user watches blocks change as the assistant works).
 */
import { streamText, tool, convertToModelMessages, stepCountIs, type UIMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

const INSTRUCTIONS = `You are the assistant inside OpenNewsletter, a generation-first newsletter studio.

You help the user write and design email newsletters. The newsletter body is an ordered list of BLOCKS. You change it by calling tools — never describe edits you could make, just make them, then say one short sentence about what you did.

Authoring rules:
- Newsletters are a single vertical column. Favour clear headings, short paragraphs, the occasional list, a divider between sections, and at most one call-to-action button.
- Write real, specific copy — not lorem ipsum or "[placeholder]". If the user is vague, make tasteful editorial choices.

Working with EXISTING content (this is the common case):
- The outline shows every current block with its id and type. These blocks already carry deliberate styling — an "eyebrow" (small uppercase accent), a "deck" (italic standfirst), a button, etc. PRESERVE that structure.
- To change the topic, tone, or wording — e.g. "make it about X", "make it punchier" — REWRITE EACH BLOCK IN PLACE with edit_block (one call per block, keyed by block_id). Do NOT call set_content for this: edit_block keeps each block's type and styling, set_content throws the whole layout away.
- Use add_block only to introduce a genuinely new section, remove_block only to drop one. edit_block for a button can also change its link via the href field.

Starting fresh / restructuring:
- Use set_content (entire body as Markdown) ONLY when the newsletter is empty, or when the user explicitly asks to start over or change the layout.
- Markdown for set_content / add_block: "# Title", "## Section", paragraphs separated by blank lines, "- item" lists, "> quote", "![alt](url)" images, "[label](url)" alone on a line for a button, "---" for a divider.
- If the user attaches an image and wants it in the newsletter, call add_image with a short alt description — it uploads the attachment to storage and inserts an image block.

Design:
- Only touch design tokens (set_design) when the user asks about look, colour, fonts or roundness.

Sources:
- When GitHub repos are connected, their recent commits are provided above. To find a specific change (a feature, a fix, a release), call search_commits with the repo and keywords. Turn real commits into changelog copy — never invent shipped features.
- You can browse the user's past newsletters with list_mails, then read_mail to pull one's full content — use it to reuse a section or match their established voice.

Keep chat replies to one or two sentences. The newsletter itself is the output.`;

/**
 * Client-executed editing tools. inputSchema only, no `execute` — the AI SDK
 * surfaces these as tool-calls to the browser (useChat `onToolCall`).
 */
export const NEWSLETTER_TOOLS = {
  set_content: tool({
    description:
      "Replace the ENTIRE newsletter body with new content, written as Markdown. Use for writing a newsletter from scratch or a complete rewrite.",
    inputSchema: z.object({ markdown: z.string().describe("The full newsletter body as Markdown.") }),
  }),
  add_block: tool({
    description: "Add one or more blocks (parsed from Markdown) to the newsletter.",
    inputSchema: z.object({
      markdown: z.string().describe("Markdown for the block(s) to add."),
      position: z.enum(["start", "end"]).default("end"),
    }),
  }),
  edit_block: tool({
    description:
      "Rewrite ONE existing block's text in place, keeping its type and styling (eyebrow, deck, heading level, button, etc.). This is the right tool for changing wording, topic or tone. For a list, separate items with newlines; for a button you may also pass href.",
    inputSchema: z.object({
      block_id: z.string(),
      text: z.string().describe("The new text/copy for this block."),
      href: z.string().optional().describe("New link, for a button block only."),
    }),
  }),
  remove_block: tool({
    description: "Delete one block by its id.",
    inputSchema: z.object({ block_id: z.string() }),
  }),
  set_title: tool({
    description: "Set the newsletter title (used as the email subject line).",
    inputSchema: z.object({ title: z.string() }),
  }),
  set_design: tool({
    description:
      "Change one brand/design token. key is a dot-path: colors.primary, colors.background, colors.text, colors.secondary, typography.headingFont, typography.bodyFont, layout.buttonRadius, layout.imageRadius.",
    inputSchema: z.object({
      key: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
    }),
  }),
  add_image: tool({
    description:
      "Insert an image the user attached to the chat into the newsletter — uploads it to storage and adds an image block. Call this when the user attaches an image and wants it included.",
    inputSchema: z.object({ alt: z.string().describe("Short alt text describing the image.") }),
  }),
};

/** Compact snapshot of the current mail, fed to the assistant each turn. */
export type ChatContext = {
  title?: string;
  outline?: string;
  design?: string;
};

function contextMessage(ctx: ChatContext | undefined): string {
  if (!ctx) return "";
  const lines = ["Current newsletter state:"];
  if (ctx.title) lines.push(`Title: ${ctx.title}`);
  if (ctx.design) lines.push(`Design: ${ctx.design}`);
  lines.push("", "Body outline (block_id — type — preview):", ctx.outline || "(empty — no blocks yet)");
  return lines.join("\n");
}

// ── Hints (sources the assistant can ground on) ──────────────────────

/** A source the user connected in the chat. GitHub repo only today. */
export type Hint = { kind: "github"; repo: string };

const ghHeaders = (token?: string): Record<string, string> => ({
  "User-Agent": "open-newsletter",
  Accept: "application/vnd.github+json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

const cleanSlug = (repo: string) => repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
const isSlug = (slug: string) => /^[\w.-]+\/[\w.-]+$/.test(slug);

function commitLines(
  items: Array<{ commit?: { message?: string; author?: { date?: string } } }>,
): string[] {
  return items
    .map((c) => {
      const subject = (c.commit?.message || "").split("\n")[0];
      const date = (c.commit?.author?.date || "").slice(0, 10);
      return subject ? `- ${subject}${date ? ` (${date})` : ""}` : "";
    })
    .filter(Boolean);
}

async function recentCommits(repo: string, token?: string): Promise<string | null> {
  const slug = cleanSlug(repo);
  if (!isSlug(slug)) return null;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const r = await fetch(`https://api.github.com/repos/${slug}/commits?per_page=40&since=${since}`, { headers: ghHeaders(token) });
  if (!r.ok) return null;
  const lines = commitLines((await r.json()) as Parameters<typeof commitLines>[0]);
  return lines.length ? `Recent commits in ${slug} (last 7 days):\n${lines.join("\n")}` : null;
}

/**
 * Recent commits for each connected repo, injected as passive grounding. The
 * assistant can go deeper on its own via the search_commits tool.
 */
export async function buildHintsContext(hints: Hint[] | undefined, env: { GITHUB_TOKEN?: string }): Promise<string> {
  if (!hints?.length) return "";
  const blocks: string[] = [];
  for (const h of hints) {
    if (h.kind === "github" && h.repo) {
      const c = await recentCommits(h.repo, env.GITHUB_TOKEN);
      if (c) blocks.push(c);
    }
  }
  if (!blocks.length) return "";
  return `\n\nCONNECTED SOURCES — recent activity, use as factual grounding (e.g. turn commits into a changelog):\n${blocks.join("\n\n")}`;
}

/** Server-executed tool: lets the assistant freely search commits in the connected repos. */
function searchCommitsTool(allowedRepos: string[], token?: string) {
  return tool({
    description:
      "Search commit messages in a connected GitHub repo. Use when you need a specific change (a feature, a fix, a release) rather than just the recent commits already provided.",
    inputSchema: z.object({
      repo: z.string().describe("owner/name — must be one of the connected repos."),
      query: z.string().describe("Keywords to match in commit messages."),
    }),
    execute: async ({ repo, query }) => {
      const slug = cleanSlug(repo);
      if (!allowedRepos.includes(slug)) return `"${slug}" is not connected. Connected repos: ${allowedRepos.join(", ") || "none"}.`;
      const q = encodeURIComponent(`repo:${slug} ${query}`);
      const r = await fetch(`https://api.github.com/search/commits?q=${q}&per_page=20`, { headers: ghHeaders(token) });
      if (!r.ok) return `GitHub search failed (${r.status}).`;
      const data = (await r.json()) as { items?: Parameters<typeof commitLines>[0] };
      const lines = commitLines(data.items || []);
      return lines.length ? `Commits in ${slug} matching "${query}":\n${lines.join("\n")}` : `No commits in ${slug} matched "${query}".`;
    },
  });
}

// ── Reading past newsletters (server-executed, DB-backed) ────────────

/** DB access the route hands the assistant so it can browse past newsletters. */
export type MailReaders = {
  list: () => Promise<Array<{ id: number; title: string; status: string }>>;
  read: (id: number) => Promise<{ title: string; markdown: string } | null>;
};

function readerTools(readers: MailReaders) {
  return {
    list_mails: tool({
      description: "List the user's past newsletters (id, title, status). Use to find one to reference, reuse a section, or match its voice.",
      inputSchema: z.object({}),
      execute: async () => {
        const mails = await readers.list();
        return mails.length ? mails.map((m) => `#${m.id} [${m.status}] ${m.title || "Untitled"}`).join("\n") : "No past newsletters yet.";
      },
    }),
    read_mail: tool({
      description: "Read a past newsletter's full content as Markdown by its id — e.g. to reuse a section or mirror its style.",
      inputSchema: z.object({ mail_id: z.number() }),
      execute: async ({ mail_id }) => {
        const m = await readers.read(mail_id);
        return m ? `# ${m.title || "Untitled"}\n\n${m.markdown}` : `No newsletter with id ${mail_id}.`;
      },
    }),
  };
}

/** Stream a chat turn as a UI-message stream response for `useChat`. */
export async function streamNewsletterChat(opts: {
  apiKey: string;
  model?: string;
  messages: UIMessage[];
  context?: ChatContext;
  hintsText?: string;
  github?: { repos: string[]; token?: string };
  readers?: MailReaders;
}): Promise<Response> {
  const openrouter = createOpenRouter({ apiKey: opts.apiKey });
  const repos = opts.github?.repos || [];
  const tools = {
    ...NEWSLETTER_TOOLS,
    ...(opts.readers ? readerTools(opts.readers) : {}),
    ...(repos.length ? { search_commits: searchCommitsTool(repos, opts.github?.token) } : {}),
  };
  const result = streamText({
    model: openrouter(opts.model || DEFAULT_MODEL),
    system: `${INSTRUCTIONS}\n\n${contextMessage(opts.context)}${opts.hintsText || ""}`,
    messages: await convertToModelMessages(opts.messages),
    tools,
    stopWhen: stepCountIs(8),
  });
  return result.toUIMessageStreamResponse();
}
