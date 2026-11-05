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
import { OP_INPUTS } from "../shared/mail-ops";
import { cleanSlug, searchCommits } from "./sources";

export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

const INSTRUCTIONS = `You are the assistant inside OpenNewsletter, a generation-first newsletter studio.

You help the user write and design email newsletters. The newsletter body is an ordered list of BLOCKS. You change it by calling tools — never describe edits you could make, just make them, then say one short sentence about what you did.

Authoring rules:
- Newsletters are a single vertical column. Favour clear headings, short paragraphs, the occasional list, a divider between sections, and at most one call-to-action button.
- Write real, specific copy — not lorem ipsum or "[placeholder]". If the user is vague, make tasteful editorial choices.
- To address each reader, use merge tags in any text: {{first_name}}, {{last_name}}, {{email}}, with a fallback after a bar for an empty value, e.g. "Hi {{first_name|there}},". Use no other tags.

Working with EXISTING content (this is the common case):
- The outline shows every current block with its id and type. These blocks already carry deliberate styling — an "eyebrow" (small uppercase accent), a "deck" (italic standfirst), a button, etc. PRESERVE that structure.
- To change the topic, tone, or wording — e.g. "make it about X", "make it punchier" — REWRITE EACH BLOCK IN PLACE with edit_block (one call per block, keyed by block_id). Do NOT call set_content for this: edit_block keeps each block's type and styling, set_content throws the whole layout away.
- Use add_block only to introduce a genuinely new section, remove_block only to drop one. edit_block for a button can also change its link via the href field.

Starting fresh / restructuring:
- Use set_content (entire body as Markdown) ONLY when the newsletter is empty, or when the user explicitly asks to start over or change the layout.
- Markdown for set_content / add_block: "# Title", "## Section", paragraphs separated by blank lines, "- item" lists, "> quote", "![alt](url)" images, "[label](url)" alone on a line for a button, "---" for a divider.
- If the user attaches an image and wants it in the newsletter, call add_image with a short alt description — it uploads the attachment to storage and inserts an image block.

Styling blocks: style_block gives any block a coloured section (a band, a callout, a dark hero) with padding; text inside switches to a readable colour on its own. It also sizes and aligns images and sets a button to outline or full width. Reach for it before HTML.

HTML blocks (for designs the other blocks can't express: a hero with a background, a coloured band, a multi-column layout with buttons, a pasted snippet):
- add_html_block adds one; edit_block on an html block replaces its whole HTML (the outline shows it in full).
- Write email HTML: tables for layout, inline styles, absolute image URLs, at most 600px wide. No scripts, forms or external CSS; mail clients drop them. Merge tags work inside.
- Prefer the regular blocks when they can do the job: they follow the design settings and an HTML block doesn't.

Design:
- Only touch design tokens (set_design) when the user asks about look, colour, fonts or roundness.

Sources:
- The publication's sources (GitHub repos set in Settings) have their recent commits provided above when there are any. To find a specific change (a feature, a fix, a release), call search_commits with the repo and keywords. Turn real commits into changelog copy; never invent shipped features.
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
    inputSchema: OP_INPUTS.set_content,
  }),
  add_block: tool({
    description: "Add one or more blocks (parsed from Markdown) to the newsletter.",
    inputSchema: OP_INPUTS.add_block,
  }),
  edit_block: tool({
    description:
      "Rewrite ONE existing block's text in place, keeping its type and styling (eyebrow, deck, heading level, button, etc.). This is the right tool for changing wording, topic or tone. For a list, separate items with newlines; for a button you may also pass href.",
    inputSchema: OP_INPUTS.edit_block,
  }),
  remove_block: tool({
    description: "Delete one block by its id.",
    inputSchema: OP_INPUTS.remove_block,
  }),
  set_title: tool({
    description: "Set the newsletter title (used as the email subject line).",
    inputSchema: OP_INPUTS.set_title,
  }),
  set_design: tool({
    description:
      "Change one brand/design token. key is a dot-path: colors.primary, colors.background, colors.foreground (text), colors.secondary, typography.headingFont, typography.bodyFont, layout.buttonRadius, layout.imageRadius.",
    inputSchema: OP_INPUTS.set_design,
  }),
  style_block: tool({
    description:
      "Style one block: a coloured section behind it with padding, an image's width and alignment, or a button's look. Pass only what changes.",
    inputSchema: OP_INPUTS.style_block,
  }),
  add_html_block: tool({
    description:
      "Add a block of raw email HTML (tables + inline styles) for a design the regular blocks can't express. It renders as written and does not follow the design tokens.",
    inputSchema: OP_INPUTS.add_html_block,
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

// ── Sources (Settings) ──────────────────────────────────────────────

/** Server-executed tool: lets the assistant freely search commits in the connected repos. */
function searchCommitsTool(allowedRepos: string[], token?: string) {
  return tool({
    description:
      "Search commit messages in one of the publication's GitHub sources. Use when you need a specific change (a feature, a fix, a release) rather than just the recent commits already provided.",
    inputSchema: z.object({
      repo: z.string().describe("owner/name, one of the sources."),
      query: z.string().describe("Keywords to match in commit messages."),
    }),
    execute: async ({ repo, query }) => {
      const slug = cleanSlug(repo);
      if (!allowedRepos.includes(slug)) return `"${slug}" is not one of the sources. Sources: ${allowedRepos.join(", ") || "none"}.`;
      const r = await searchCommits(slug, query, token);
      if (!r.ok) return r.error;
      return r.commits.length ? `Commits in ${slug} matching "${query}":\n${r.commits.map((l) => `- ${l}`).join("\n")}` : `No commits in ${slug} matched "${query}".`;
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
