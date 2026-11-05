/**
 * The editing vocabulary for a newsletter issue: set the body, add / edit /
 * style / remove a block, set the subject, change a design token, add an image
 * or an HTML block. One implementation, two callers:
 *
 *  - the editor applies an op locally when the in-app assistant streams a tool
 *    call (outside Clawnify), so it rides the undo stack as the user watches;
 *  - `POST /api/mails/:id/edit` applies a list of ops on the server, which is
 *    how the Clawnify sidebar chat edits an issue through the app's API.
 *
 * Two copies of these rules would drift, and the two chats would then make
 * different newsletters from the same request.
 */
import { z } from "zod";
import { markdownToBlocks, deriveTitle, blockId } from "./blocks";
import { cleanTokens, diffTokens, type DesignTokens } from "./design";
import type { Block, Mail } from "./types";

const position = z.enum(["start", "end"]).default("end");

/** Each op's input, validated wherever an op arrives from outside (the API). */
export const OP_INPUTS = {
  set_content: z.object({ markdown: z.string().describe("The full newsletter body as Markdown.") }),
  add_block: z.object({ markdown: z.string().describe("Markdown for the block(s) to add."), position }),
  edit_block: z.object({
    block_id: z.string(),
    text: z.string().describe("The new text/copy for this block."),
    href: z.string().optional().describe("New link, for a button block only."),
  }),
  remove_block: z.object({ block_id: z.string() }),
  set_title: z.object({ title: z.string() }),
  set_design: z.object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }),
  style_block: z.object({
    block_id: z.string(),
    background: z.string().optional().describe('A design colour (page, primary, secondary, foreground, border), a hex like "#F4F4F5", or "none" to remove the section.'),
    padding: z.number().min(0).max(64).optional().describe("Inner padding in px (0-64)."),
    image_width: z.number().min(10).max(100).optional().describe("Image width as a percent of the content (10-100)."),
    image_align: z.enum(["left", "center", "right"]).optional(),
    button_variant: z.enum(["solid", "outline"]).optional(),
    button_full_width: z.boolean().optional(),
  }),
  add_html_block: z.object({ html: z.string().describe("Email-safe HTML: tables for layout, inline styles, no scripts."), position }),
  add_image: z.object({ src: z.string().describe("Absolute image URL, e.g. the url POST /api/upload returns."), alt: z.string().default("") }),
} as const;

export type OpName = keyof typeof OP_INPUTS;
export const OP_NAMES = Object.keys(OP_INPUTS) as OpName[];

/** The tokens set_design may change, as dot-paths. */
export const DESIGN_KEYS = new Set([
  "colors.primary", "colors.background", "colors.foreground", "colors.secondary", "colors.onPrimary",
  "typography.headingFont", "typography.bodyFont",
  "layout.buttonRadius", "layout.imageRadius", "layout.cardRadius", "layout.contentWidth", "layout.outerPadding",
]);

/**
 * Set one allow-listed dot-path token on a clone of the base design, or null
 * when the key isn't allowed or the value is one the design can't use. The
 * value goes through cleanTokens, the one check every token passes (numbers
 * clamp to the design panel's ranges); a value it would drop is refused here,
 * because dropping it on save would also lose the value it replaced.
 */
export function setDesignKey(base: DesignTokens, key: string, value: unknown): DesignTokens | null {
  if (!DESIGN_KEYS.has(key)) return null;
  const [group, field] = key.split(".");
  const kept = (cleanTokens({ [group]: { [field]: value } }) as Record<string, Record<string, unknown> | undefined>)[group]?.[field];
  if (kept === undefined) return null;
  const next = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
  next[group][field] = kept;
  return next as unknown as DesignTokens;
}

export type OpTarget = Pick<Mail, "blocks" | "title">;
export type OpResult = { ok: true; patch: Partial<Mail>; message: string } | { ok: false; message: string };

/**
 * Apply one op to an issue and return the fields it changes. `base` is the
 * issue's desktop design (its own, else its template's, else the default);
 * on `mobile` a design change is stored as an override of it.
 */
export function applyMailOp(
  mail: OpTarget,
  name: string,
  input: Record<string, unknown>,
  opts: { base: DesignTokens; device?: "desktop" | "mobile" },
): OpResult {
  const blocks = mail.blocks || [];
  switch (name) {
    case "set_content": {
      const next = markdownToBlocks(String(input.markdown || ""));
      return { ok: true, patch: { blocks: next, title: deriveTitle(next) }, message: `Replaced the body with ${next.length} block(s).` };
    }
    case "add_block": {
      const add = markdownToBlocks(String(input.markdown || ""));
      return { ok: true, patch: { blocks: input.position === "start" ? [...add, ...blocks] : [...blocks, ...add] }, message: `Added ${add.length} block(s).` };
    }
    case "edit_block": {
      const text = String(input.text ?? input.markdown ?? "");
      let touched = false;
      const next = blocks.map((b): Block => {
        if (b.id !== input.block_id) return b;
        touched = true;
        switch (b.type) {
          case "heading": return { ...b, text };
          case "text": return { ...b, md: text };
          case "button": return { ...b, text, ...(input.href ? { href: String(input.href) } : {}) };
          case "quote": return { ...b, text };
          case "list": return { ...b, items: text.split("\n").map((s) => s.replace(/^\s*[-*+]\s+|^\s*\d+\.\s+/, "").trim()).filter(Boolean) };
          case "image": return { ...b, alt: text };
          case "html": return { ...b, html: text };
          default: return b; // divider, spacer, columns: nothing textual to set
        }
      });
      if (!touched) return { ok: false, message: `No block with id ${input.block_id}.` };
      return { ok: true, patch: { blocks: next }, message: "Rewrote the block in place." };
    }
    case "remove_block": {
      if (!blocks.some((b) => b.id === input.block_id)) return { ok: false, message: `No block with id ${input.block_id}.` };
      return { ok: true, patch: { blocks: blocks.filter((b) => b.id !== input.block_id) }, message: "Removed the block." };
    }
    case "set_title": {
      // The subject is the issue's top heading: every save that touches the
      // blocks re-derives it from there (deriveTitle), so a subject set only on
      // the field would be undone by the next block edit. Change that heading.
      const title = String(input.title || "");
      const h1 = blocks.findIndex((b) => b.type === "heading" && b.level === 1);
      const at = h1 >= 0 ? h1 : blocks.findIndex((b) => b.type === "heading");
      if (at < 0) return { ok: true, patch: { title }, message: "Set the subject." };
      return {
        ok: true,
        patch: { blocks: blocks.map((b, i) => (i === at ? ({ ...b, text: title } as Block) : b)), title },
        message: "Set the subject (the issue's top heading).",
      };
    }
    case "set_design": {
      const next = setDesignKey(opts.base, String(input.key), input.value);
      if (!next) {
        return DESIGN_KEYS.has(String(input.key))
          ? { ok: false, message: `${JSON.stringify(input.value)} isn't a usable value for ${input.key}.` }
          : { ok: false, message: `I can't set "${input.key}". Tokens: ${[...DESIGN_KEYS].join(", ")}.` };
      }
      return { ok: true, patch: opts.device === "mobile" ? { design_mobile: diffTokens(opts.base, next) } : { design: next }, message: `Set ${input.key}.` };
    }
    case "style_block": {
      let found = false;
      const next = blocks.map((b): Block => {
        if (b.id !== input.block_id) return b;
        found = true;
        const s = { ...b } as Block & Record<string, unknown>;
        if (input.background !== undefined || input.padding !== undefined) {
          const bg = input.background === "none" ? undefined : input.background !== undefined ? String(input.background) : b.box?.background;
          const pad = input.padding !== undefined ? Number(input.padding) : b.box?.padding;
          s.box = bg || pad ? { ...(bg ? { background: bg } : {}), ...(pad !== undefined ? { padding: pad } : {}) } : undefined;
        }
        if (b.type === "image") {
          if (input.image_width !== undefined) s.width = Number(input.image_width);
          if (input.image_align !== undefined) s.align = input.image_align;
        }
        if (b.type === "button") {
          if (input.button_variant !== undefined) s.variant = input.button_variant === "outline" ? "outline" : undefined;
          if (input.button_full_width !== undefined) s.fullWidth = input.button_full_width ? true : undefined;
        }
        return s;
      });
      if (!found) return { ok: false, message: `No block with id ${input.block_id}.` };
      return { ok: true, patch: { blocks: next }, message: "Styled the block." };
    }
    case "add_html_block": {
      const block: Block = { id: blockId(), type: "html", html: String(input.html || "") };
      return { ok: true, patch: { blocks: input.position === "start" ? [block, ...blocks] : [...blocks, block] }, message: "Added the HTML block." };
    }
    case "add_image": {
      const src = String(input.src || "");
      if (!src) return { ok: false, message: "No image to add." };
      const block: Block = { id: blockId(), type: "image", src, alt: String(input.alt || ""), caption: "", href: "" };
      return { ok: true, patch: { blocks: [...blocks, block] }, message: "Added the image." };
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

/** One-line preview of a block, for an assistant's outline. */
export function blockPreview(b: Block): string {
  const clip = (s: string) => (s.length > 60 ? s.slice(0, 57) + "…" : s);
  switch (b.type) {
    case "heading": return clip(b.text) + ` (h${b.level})`;
    case "text": return clip(b.md);
    case "image": return `image ${b.alt || b.src}`;
    case "button": return `button "${b.text}"`;
    case "list": return clip(b.items.join(", "));
    case "quote": return clip(b.text);
    case "divider": return "divider";
    case "spacer": return "spacer";
    case "columns": return `${b.items.length} columns`;
    // In full (to a cap), so an assistant can rewrite it with edit_block.
    case "html": return b.html.length > 4000 ? b.html.slice(0, 4000) + "\n…(truncated)" : b.html;
  }
}

/** Every block as `[id] type: preview`, the outline both assistants work from. */
export function mailOutline(blocks: Block[]): string {
  return blocks.map((b) => `[${b.id}] ${b.type}${b.box?.background ? ` (section ${b.box.background})` : ""}: ${blockPreview(b)}`).join("\n") || "(empty)";
}

/** The design facts an assistant needs, in one line. */
export function designSummary(d: DesignTokens): string {
  return `primary ${d.colors.primary}, background ${d.colors.background}, heading font ${d.typography.headingFont}, button radius ${d.layout.buttonRadius}px`;
}
