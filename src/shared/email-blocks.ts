/**
 * One block as email-safe HTML: every style inlined, since Gmail strips <head>
 * CSS. Shared by the email renderer and the editor's "Edit as HTML", so a block
 * converted to HTML starts as exactly what it sent.
 */
import { markdownToHtml } from "./markdown";
import { fontStack, type DesignTokens } from "./design";
import { readableOr, readableTextOn } from "./contrast";
import { fillTags, type MergeValues } from "./merge";
import { balanceTags, cleanEmailHtml } from "./email-html";
import type { Block, TextColor } from "./types";

export function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textColor(c: TextColor | undefined, d: DesignTokens): string {
  if (c === "primary") return d.colors.primary;
  if (c === "secondary") return d.colors.secondary;
  return d.colors.foreground;
}

/** Inline styles for the class-free HTML from markdownToHtml. */
function styleInline(html: string, d: DesignTokens): string {
  const repl: Array<[RegExp, string]> = [
    [/<p>/g, `<p style="margin:0;">`],
    [/<a /g, `<a style="color:${d.colors.link};text-decoration:underline;" `],
    [/<strong>/g, `<strong style="font-weight:700;">`],
  ];
  return repl.reduce((acc, [re, s]) => acc.replace(re, s), html);
}

/** An HTML block's markup as it goes out: cleaned, balanced, tags filled with escaped values. */
export function renderHtmlBlock(html: string, merge?: MergeValues): string {
  return fillTags(html, merge, (x) => balanceTags(cleanEmailHtml(x)));
}

/** Design colours a box background can name; anything else must be a hex value. */
export const BOX_COLORS = ["page", "primary", "secondary", "foreground", "border"] as const;

export interface BoxLook {
  background: string;
  padding: number;
  radius: number;
  /** The design with text colours adjusted to read on `background`. */
  design: DesignTokens;
}

/**
 * How a block's box looks, or null when it has none (the block renders bare).
 * Shared by the email and the editor canvas so both agree.
 */
export function blockBox(b: Block, d: DesignTokens): BoxLook | null {
  const box = b.box;
  if (!box || (!box.background && !box.padding)) return null;
  const named = (BOX_COLORS as readonly string[]).includes(box.background ?? "");
  const hex = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(box.background ?? "");
  const background = named ? d.colors[box.background as (typeof BOX_COLORS)[number]] : hex ? box.background! : "";
  const on = background || d.colors.background;
  const colors = {
    ...d.colors,
    foreground: readableOr(d.colors.foreground, on),
    secondary: readableOr(d.colors.secondary, on),
    primary: readableOr(d.colors.primary, on),
    link: readableOr(d.colors.link, on),
  };
  return {
    background,
    padding: Math.max(0, Math.min(64, Math.round(box.padding ?? (background ? 24 : 0)))),
    radius: background ? Math.min(d.layout.cardRadius, 16) : 0,
    design: { ...d, colors },
  };
}

/** One block, inside its box when it has one. */
export function renderBlock(b: Block, d: DesignTokens, merge?: MergeValues, legacyColumns?: boolean): string {
  const box = blockBox(b, d);
  if (!box) return renderBlockContent(b, d, merge, legacyColumns);
  const fill = box.background ? ` bgcolor="${box.background}"` : "";
  const bg = box.background ? `background:${box.background};` : "";
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;"><tr><td${fill} style="${bg}padding:${box.padding}px;border-radius:${box.radius}px;">${renderBlockContent(b, box.design, merge, legacyColumns)}</td></tr></table>`;
}

function renderBlockContent(b: Block, d: DesignTokens, merge?: MergeValues, legacyColumns?: boolean): string {
  /** Escaped plain text, tags filled. */
  const t = (s: string) => fillTags(s, merge, esc);
  /** Markdown, tags filled after parsing so a value can't add markup. */
  const md = (s: string) => fillTags(s, merge, (x) => styleInline(markdownToHtml(x), d));
  const body = fontStack(d.typography.bodyFont);
  const heading = fontStack(d.typography.headingFont);
  const base = d.typography.baseSize;

  switch (b.type) {
    case "heading": {
      const size = b.level === 1 ? d.typography.titleSize : b.level === 2 ? base + 8 : base + 3;
      const lh = b.level === 1 ? 1.12 : 1.25;
      const cls = b.level === 1 ? "nl-title" : "";
      return `<h${b.level} class="${cls}" style="margin:0;font-family:${heading};font-weight:${d.typography.headingWeight};font-size:${size}px;line-height:${lh};letter-spacing:${b.level === 1 ? "-0.01em" : "0"};color:${d.colors.foreground};text-align:${b.align || "left"};">${t(b.text)}</h${b.level}>`;
    }
    case "text": {
      const size = Math.round(base * (b.scale || 1));
      const css = [
        `font-family:${body}`,
        `font-size:${size}px`,
        `line-height:${d.typography.lineHeight}`,
        `color:${textColor(b.color, d)}`,
        `text-align:${b.align || "left"}`,
        b.italic ? "font-style:italic" : "",
        b.uppercase ? "text-transform:uppercase;letter-spacing:0.06em;font-weight:600" : "",
      ].filter(Boolean).join(";");
      return `<div class="nl-text" style="${css}">${md(b.md)}</div>`;
    }
    case "image": {
      const sized = b.width !== undefined || b.align !== undefined;
      const pct = Math.max(10, Math.min(100, Math.round(b.width ?? 100)));
      // Outlook reads the width attribute, in pixels; everyone else reads the style.
      const img = sized
        ? `<img src="${esc(b.src)}" alt="${esc(b.alt)}" width="${Math.round((d.layout.contentWidth * pct) / 100)}" style="width:${pct}%;max-width:100%;height:auto;display:inline-block;border:0;border-radius:${d.layout.imageRadius}px;">`
        : `<img src="${esc(b.src)}" alt="${esc(b.alt)}" width="100%" style="width:100%;height:auto;display:block;border:0;border-radius:${d.layout.imageRadius}px;">`;
      const linked = b.href ? `<a href="${esc(b.href)}" target="_blank">${img}</a>` : img;
      const wrapped = sized ? `<div style="text-align:${b.align || "center"};line-height:0;">${linked}</div>` : linked;
      const cap = b.caption ? `<div style="font-family:${body};font-size:13px;color:${d.colors.secondary};text-align:center;margin-top:8px;">${t(b.caption)}</div>` : "";
      return wrapped + cap;
    }
    case "button": {
      const fg = d.options.autoButtonText === false ? d.colors.onPrimary : readableTextOn(d.colors.primary);
      if (b.variant === undefined && b.fullWidth === undefined) {
        return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" align="${b.align || "left"}" style="border-collapse:separate;"><tr><td align="center" bgcolor="${d.colors.primary}" style="border-radius:${d.layout.buttonRadius}px;background:${d.colors.primary};"><a href="${esc(b.href)}" target="_blank" style="display:inline-block;font-family:${body};font-weight:600;font-size:${base}px;color:${fg};text-decoration:none;padding:12px 22px;border-radius:${d.layout.buttonRadius}px;">${t(b.text)}</a></td></tr></table>`;
      }
      const outline = b.variant === "outline";
      const full = b.fullWidth === true;
      const cell = outline
        ? `style="border-radius:${d.layout.buttonRadius}px;border:2px solid ${d.colors.primary};"`
        : `bgcolor="${d.colors.primary}" style="border-radius:${d.layout.buttonRadius}px;background:${d.colors.primary};"`;
      const link = `display:${full ? "block" : "inline-block"};font-family:${body};font-weight:600;font-size:${base}px;color:${outline ? d.colors.primary : fg};text-decoration:none;padding:${outline ? "10px 20px" : "12px 22px"};border-radius:${d.layout.buttonRadius}px;text-align:center;`;
      return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" ${full ? `width="100%"` : `align="${b.align || "left"}"`} style="border-collapse:separate;"><tr><td align="center" ${cell}><a href="${esc(b.href)}" target="_blank" style="${link}">${t(b.text)}</a></td></tr></table>`;
    }
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const items = b.items.map((it) => `<li style="margin:0 0 8px;">${md(it).replace(/^<p[^>]*>|<\/p>$/g, "")}</li>`).join("");
      return `<${tag} style="margin:0;padding-left:22px;font-family:${body};font-size:${base}px;line-height:${d.typography.lineHeight};color:${d.colors.foreground};">${items}</${tag}>`;
    }
    case "quote":
      return `<blockquote style="margin:0;border-left:3px solid ${d.colors.primary};padding-left:18px;font-family:${heading};font-style:italic;font-size:${base + 4}px;line-height:1.4;color:${d.colors.secondary};">${t(b.text)}${b.cite ? `<div style="font-style:normal;font-size:13px;margin-top:8px;">— ${t(b.cite)}</div>` : ""}</blockquote>`;
    case "divider":
      return `<hr style="border:0;border-top:1px solid ${d.colors.border};margin:0;">`;
    case "spacer":
      return `<div style="height:${b.size}px;line-height:${b.size}px;font-size:0;">&nbsp;</div>`;
    case "columns": {
      const n = b.items.length || 1;
      const cells = b.items.map((c, i) => {
        const inner =
          (c.image ? `<img src="${esc(c.image)}" alt="" width="100%" style="width:100%;height:auto;display:block;border:0;border-radius:${d.layout.imageRadius}px;margin-bottom:10px;">` : "") +
          (c.heading ? `<div style="font-family:${heading};font-weight:${d.typography.headingWeight};font-size:${base + 1}px;color:${d.colors.foreground};margin-bottom:4px;">${t(c.heading)}</div>` : "") +
          (c.text ? `<div style="font-family:${body};font-size:${base - 1}px;line-height:1.5;color:${d.colors.secondary};">${t(c.text)}</div>` : "");
        return `<td class="nl-col" width="${Math.floor(100 / n)}%" valign="top" style="width:${Math.floor(100 / n)}%;padding:${legacyColumns ? "0 8px" : `0 0 0 ${i === 0 ? 0 : 16}px`};vertical-align:top;">${inner}</td>`;
      }).join("");
      return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;"><tr>${cells}</tr></table>`;
    }
    case "html":
      return renderHtmlBlock(b.html, merge);
  }
}

