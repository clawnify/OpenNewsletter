/**
 * Block helpers — conversion between Markdown and the block model.
 *
 * The AI still produces Markdown (robust, well-trained); we convert it
 * to blocks for editing and rendering. The reverse (blocks → Markdown)
 * gives the AI plain context when revising a single block or the mail.
 */
import type { Block, ColumnCell } from "./types";

export function blockId(): string {
  return `b_${Math.random().toString(36).slice(2, 9)}`;
}

// ── factories (for the "add block" menu) ─────────────────────────────

export function newBlock(type: Block["type"]): Block {
  switch (type) {
    case "heading":
      return { id: blockId(), type, level: 2, text: "Section heading" };
    case "text":
      return { id: blockId(), type, md: "Write something…" };
    case "image":
      return { id: blockId(), type, src: "", alt: "", caption: "", href: "" };
    case "button":
      return { id: blockId(), type, text: "Read more", href: "https://", align: "left" };
    case "list":
      return { id: blockId(), type, ordered: false, items: ["First item", "Second item"] };
    case "quote":
      return { id: blockId(), type, text: "A memorable line.", cite: "" };
    case "divider":
      return { id: blockId(), type };
    case "spacer":
      return { id: blockId(), type, size: 24 };
    case "columns":
      return {
        id: blockId(),
        type,
        items: [emptyCell(), emptyCell()],
      };
    case "html":
      return {
        id: blockId(),
        type,
        html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n  <tr>\n    <td style="padding:24px;background:#F4F4F5;border-radius:8px;text-align:center;font-family:Arial,sans-serif;font-size:16px;color:#111111;">\n      Your HTML here. Use tables and inline styles: mail clients ignore most CSS.\n    </td>\n  </tr>\n</table>`,
      };
  }
}

export function emptyCell(): ColumnCell {
  return { image: "", heading: "Heading", text: "Short supporting copy." };
}

// ── masthead seed helpers (masthead is just styled text/headings) ────

export function eyebrowBlock(text: string): Block {
  return { id: blockId(), type: "text", md: text, color: "primary", uppercase: true, scale: 0.82 };
}
export function titleBlock(text: string): Block {
  return { id: blockId(), type: "heading", level: 1, text };
}
export function deckBlock(text: string): Block {
  return { id: blockId(), type: "text", md: text, color: "secondary", italic: true, scale: 1.25 };
}
export function bylineBlock(text: string): Block {
  return { id: blockId(), type: "text", md: text, color: "secondary", uppercase: true, scale: 0.82 };
}

/** The email subject = first display heading, else first heading, else first text. */
export function deriveTitle(blocks: Block[]): string {
  const h1 = blocks.find((b) => b.type === "heading" && b.level === 1) as { text?: string } | undefined;
  if (h1?.text) return h1.text;
  const h = blocks.find((b) => b.type === "heading") as { text?: string } | undefined;
  if (h?.text) return h.text;
  const t = blocks.find((b) => b.type === "text") as { md?: string } | undefined;
  return (t?.md || "Untitled").slice(0, 80);
}

// ── quick-action presets: change a text/heading block's style ────────

export type TextPreset = "display" | "h2" | "h3" | "body" | "eyebrow" | "deck";

export const TEXT_PRESETS: { id: TextPreset; label: string }[] = [
  { id: "display", label: "Display" },
  { id: "h2", label: "Heading" },
  { id: "h3", label: "Subheading" },
  { id: "body", label: "Body" },
  { id: "eyebrow", label: "Eyebrow" },
  { id: "deck", label: "Deck" },
];

/** The preset a text/heading block currently matches (for the quick-action UI). */
export function currentPreset(block: Block): TextPreset | null {
  if (block.type === "heading") return block.level === 1 ? "display" : block.level === 2 ? "h2" : "h3";
  if (block.type === "text") {
    if (block.uppercase && block.color === "primary") return "eyebrow";
    if (block.italic && block.color === "secondary") return "deck";
    return "body";
  }
  return null;
}

export function applyPreset(block: Block, preset: TextPreset): Block {
  const text = block.type === "text" ? block.md : block.type === "heading" ? block.text : "";
  switch (preset) {
    case "display":
      return { id: block.id, type: "heading", level: 1, text };
    case "h2":
      return { id: block.id, type: "heading", level: 2, text };
    case "h3":
      return { id: block.id, type: "heading", level: 3, text };
    case "body":
      return { id: block.id, type: "text", md: text };
    case "eyebrow":
      return eyebrowBlockKeepId(block.id, text);
    case "deck":
      return deckBlockKeepId(block.id, text);
  }
}

function eyebrowBlockKeepId(id: string, text: string): Block {
  return { id, type: "text", md: text, color: "primary", uppercase: true, scale: 0.82 };
}
function deckBlockKeepId(id: string, text: string): Block {
  return { id, type: "text", md: text, color: "secondary", italic: true, scale: 1.25 };
}

// ── Markdown → blocks ────────────────────────────────────────────────

export function markdownToBlocks(md: string): Block[] {
  const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const pushList = (ordered: boolean, items: string[]) =>
    blocks.push({ id: blockId(), type: "list", ordered, items });

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (t === "") { i++; continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { blocks.push({ id: blockId(), type: "divider" }); i++; continue; }

    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = Math.min(3, Math.max(2, h[1].length)) as 2 | 3;
      blocks.push({ id: blockId(), type: "heading", level, text: h[2] });
      i++;
      continue;
    }

    const img = t.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (img) {
      blocks.push({ id: blockId(), type: "image", src: img[2], alt: img[1], caption: "", href: "" });
      i++;
      continue;
    }

    // A link alone on its own line is a call-to-action button.
    const btn = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (btn) {
      blocks.push({ id: blockId(), type: "button", text: btn[1], href: btn[2], align: "left" });
      i++;
      continue;
    }

    if (/^>\s?/.test(t)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ id: blockId(), type: "quote", text: buf.join(" "), cite: "" });
      continue;
    }

    const ulMatch = t.match(/^[-*+]\s+(.*)$/);
    const olMatch = t.match(/^\d+\.\s+(.*)$/);
    if (ulMatch || olMatch) {
      const ordered = !!olMatch;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].trim().match(ordered ? /^\d+\.\s+(.*)$/ : /^[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      pushList(ordered, items);
      continue;
    }

    // paragraph: consume consecutive plain lines
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|>\s?|[-*+]\s|\d+\.\s|!\[|\[[^\]]+\]\([^)\s]+\)$|(-{3,}|\*{3,}|_{3,})$)/.test(lines[i].trim())
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    blocks.push({ id: blockId(), type: "text", md: buf.join(" ") });
  }

  return blocks.length ? blocks : [{ id: blockId(), type: "text", md: "" }];
}

// ── blocks → Markdown (AI context) ───────────────────────────────────

export function blocksToMarkdown(blocks: Block[]): string {
  return (blocks || [])
    .map((b) => {
      switch (b.type) {
        case "heading":
          return `${"#".repeat(b.level)} ${b.text}`;
        case "text":
          return b.md;
        case "image":
          return `![${b.alt}](${b.src})`;
        case "button":
          return `[${b.text}](${b.href})`;
        case "list":
          return b.items.map((it, n) => (b.ordered ? `${n + 1}. ${it}` : `- ${it}`)).join("\n");
        case "quote":
          return `> ${b.text}`;
        case "divider":
          return "---";
        case "spacer":
          return "";
        case "columns":
          return b.items.map((c) => `**${c.heading}**\n${c.text}`).join("\n\n");
      }
    })
    .filter((s) => s !== "")
    .join("\n\n");
}
