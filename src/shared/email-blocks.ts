/**
 * One block as email-safe HTML: every style inlined, since Gmail strips <head>
 * CSS. Shared by the email renderer and the editor's "Edit as HTML", so a block
 * converted to HTML starts as exactly what it sent.
 */
import { markdownToHtml } from "./markdown";
import { fontStack, type DesignTokens } from "./design";
import { readableTextOn } from "./contrast";
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

export function renderBlock(b: Block, d: DesignTokens, merge?: MergeValues, legacyColumns?: boolean): string {
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
      const img = `<img src="${esc(b.src)}" alt="${esc(b.alt)}" width="100%" style="width:100%;height:auto;display:block;border:0;border-radius:${d.layout.imageRadius}px;">`;
      const wrapped = b.href ? `<a href="${esc(b.href)}" target="_blank">${img}</a>` : img;
      const cap = b.caption ? `<div style="font-family:${body};font-size:13px;color:${d.colors.secondary};text-align:center;margin-top:8px;">${t(b.caption)}</div>` : "";
      return wrapped + cap;
    }
    case "button": {
      const fg = d.options.autoButtonText === false ? d.colors.onPrimary : readableTextOn(d.colors.primary);
      return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" align="${b.align || "left"}" style="border-collapse:separate;"><tr><td align="center" bgcolor="${d.colors.primary}" style="border-radius:${d.layout.buttonRadius}px;background:${d.colors.primary};"><a href="${esc(b.href)}" target="_blank" style="display:inline-block;font-family:${body};font-weight:600;font-size:${base}px;color:${fg};text-decoration:none;padding:12px 22px;border-radius:${d.layout.buttonRadius}px;">${t(b.text)}</a></td></tr></table>`;
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

