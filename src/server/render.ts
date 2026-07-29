/**
 * Email renderer — compiles an mail's blocks + DESIGN.md tokens into
 * email-safe HTML. Newsletters are a single vertical column of blocks
 * inside a centered card; each block is one table row. Every style is
 * inlined (Gmail strips <head> CSS); a small <style> block carries only
 * the mobile @media overrides + column stacking.
 *
 * The masthead (eyebrow / title / subtitle) is just styled text and
 * display-heading blocks — there are no special masthead fields here.
 */
import { markdownToHtml } from "../shared/markdown";
import { fontStack, applyMobile, type DesignTokens } from "../shared/design";
import { readableTextOn } from "../shared/contrast";
import type { Block, Mail, Settings, TextColor } from "../shared/types";

export interface RenderOpts {
  forEmail?: boolean;
  mobile?: Partial<DesignTokens> | null;
  logo?: string;
  /**
   * This subscriber's unsubscribe URL, rendered into the footer. Per-recipient:
   * a shared link would let whoever clicks it unsubscribe the whole list.
   * Omitted for previews and test sends, which fall back to a dead link.
   */
  unsubscribeUrl?: string;
}

function esc(s: string): string {
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

function renderBlock(b: Block, d: DesignTokens): string {
  const body = fontStack(d.typography.bodyFont);
  const heading = fontStack(d.typography.headingFont);
  const base = d.typography.baseSize;

  switch (b.type) {
    case "heading": {
      const size = b.level === 1 ? d.typography.titleSize : b.level === 2 ? base + 8 : base + 3;
      const lh = b.level === 1 ? 1.12 : 1.25;
      const cls = b.level === 1 ? "nl-title" : "";
      return `<h${b.level} class="${cls}" style="margin:0;font-family:${heading};font-weight:${d.typography.headingWeight};font-size:${size}px;line-height:${lh};letter-spacing:${b.level === 1 ? "-0.01em" : "0"};color:${d.colors.foreground};text-align:${b.align || "left"};">${esc(b.text)}</h${b.level}>`;
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
      return `<div class="nl-text" style="${css}">${styleInline(markdownToHtml(b.md), d)}</div>`;
    }
    case "image": {
      const img = `<img src="${esc(b.src)}" alt="${esc(b.alt)}" width="100%" style="width:100%;height:auto;display:block;border:0;border-radius:${d.layout.imageRadius}px;">`;
      const wrapped = b.href ? `<a href="${esc(b.href)}" target="_blank">${img}</a>` : img;
      const cap = b.caption ? `<div style="font-family:${body};font-size:13px;color:${d.colors.secondary};text-align:center;margin-top:8px;">${esc(b.caption)}</div>` : "";
      return wrapped + cap;
    }
    case "button": {
      const fg = d.options.autoButtonText === false ? d.colors.onPrimary : readableTextOn(d.colors.primary);
      return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" align="${b.align || "left"}" style="border-collapse:separate;"><tr><td align="center" bgcolor="${d.colors.primary}" style="border-radius:${d.layout.buttonRadius}px;background:${d.colors.primary};"><a href="${esc(b.href)}" target="_blank" style="display:inline-block;font-family:${body};font-weight:600;font-size:${base}px;color:${fg};text-decoration:none;padding:12px 22px;border-radius:${d.layout.buttonRadius}px;">${esc(b.text)}</a></td></tr></table>`;
    }
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const items = b.items.map((it) => `<li style="margin:0 0 8px;">${styleInline(markdownToHtml(it), d).replace(/^<p[^>]*>|<\/p>$/g, "")}</li>`).join("");
      return `<${tag} style="margin:0;padding-left:22px;font-family:${body};font-size:${base}px;line-height:${d.typography.lineHeight};color:${d.colors.foreground};">${items}</${tag}>`;
    }
    case "quote":
      return `<blockquote style="margin:0;border-left:3px solid ${d.colors.primary};padding-left:18px;font-family:${heading};font-style:italic;font-size:${base + 4}px;line-height:1.4;color:${d.colors.secondary};">${esc(b.text)}${b.cite ? `<div style="font-style:normal;font-size:13px;margin-top:8px;">— ${esc(b.cite)}</div>` : ""}</blockquote>`;
    case "divider":
      return `<hr style="border:0;border-top:1px solid ${d.colors.border};margin:0;">`;
    case "spacer":
      return `<div style="height:${b.size}px;line-height:${b.size}px;font-size:0;">&nbsp;</div>`;
    case "columns": {
      const n = b.items.length || 1;
      const cells = b.items.map((c) => {
        const inner =
          (c.image ? `<img src="${esc(c.image)}" alt="" width="100%" style="width:100%;height:auto;display:block;border:0;border-radius:${d.layout.imageRadius}px;margin-bottom:10px;">` : "") +
          (c.heading ? `<div style="font-family:${heading};font-weight:${d.typography.headingWeight};font-size:${base + 1}px;color:${d.colors.foreground};margin-bottom:4px;">${esc(c.heading)}</div>` : "") +
          (c.text ? `<div style="font-family:${body};font-size:${base - 1}px;line-height:1.5;color:${d.colors.secondary};">${esc(c.text)}</div>` : "");
        return `<td class="nl-col" width="${Math.floor(100 / n)}%" valign="top" style="width:${Math.floor(100 / n)}%;padding:0 8px;vertical-align:top;">${inner}</td>`;
      }).join("");
      return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;"><tr>${cells}</tr></table>`;
    }
  }
}

export function renderInner(mail: Mail, d: DesignTokens, settings: Settings, opts: RenderOpts = {}): string {
  const rows: string[] = [];
  const space = d.layout.spacing;
  const body = fontStack(d.typography.bodyFont);
  const logo = opts.logo || settings.logo;

  if (d.options.showHeader && logo) {
    rows.push(`<tr><td style="padding:0 0 ${space}px;"><img src="${esc(logo)}" alt="${esc(settings.publication_name)}" height="28" style="height:28px;width:auto;display:block;border:0;"></td></tr>`);
  }
  for (const b of mail.blocks || []) rows.push(`<tr><td style="padding:${space}px 0 0;">${renderBlock(b, d)}</td></tr>`);

  if (d.options.showFooter) {
    // Was `{{{RESEND_UNSUBSCRIBE_URL}}}`, a Resend-Broadcasts-only variable —
    // a dead literal now that sends are per-recipient. The app hosts its own
    // unsubscribe page instead, so the link is the publication's, not a
    // third party's.
    const unsub = opts.unsubscribeUrl || "#";
    const footerText = settings.footer_text || `You're receiving this because you subscribed to ${settings.publication_name || "our newsletter"}.`;
    rows.push(
      `<tr><td style="padding:${space + 8}px 0 0;"><div style="font-family:${body};font-size:12px;line-height:1.5;color:${d.colors.secondary};border-top:1px solid ${d.colors.border};padding-top:${space}px;">` +
        `${esc(settings.publication_name || "")}<br>${esc(footerText)}<br>` +
        `<a href="${unsub}" style="color:${d.colors.secondary};font-weight:600;text-decoration:underline;">Unsubscribe</a></div></td></tr>`,
    );
  }

  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">${rows.join("")}</table>`;
}

function mobileStyle(desktop: DesignTokens, mobile?: Partial<DesignTokens> | null): string {
  const rules: string[] = [".nl-col{display:block!important;width:100%!important;padding:8px 0!important}"];
  if (mobile) {
    const m = applyMobile(desktop, mobile);
    if (m.typography.titleSize !== desktop.typography.titleSize) rules.push(`.nl-title{font-size:${m.typography.titleSize}px!important}`);
    if (m.typography.baseSize !== desktop.typography.baseSize) rules.push(`.nl-text{font-size:${m.typography.baseSize}px!important}`);
    if (m.colors.background !== desktop.colors.background) rules.push(`.nl-card{background:${m.colors.background}!important}`);
  }
  return `@media only screen and (max-width:600px){${rules.join("")}}`;
}

export function renderEmailHtml(mail: Mail, d: DesignTokens, settings: Settings, opts: RenderOpts = {}): string {
  const inner = renderInner(mail, d, settings, { ...opts, forEmail: true });
  const pad = d.layout.cardRadius > 0 ? 32 : 0;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>${esc(mail.title)}</title>
<style>${mobileStyle(d, opts.mobile)}</style>
</head>
<body style="margin:0;padding:0;background:${d.colors.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${d.colors.page};">
<tr><td align="center" style="padding:${d.layout.outerPadding || 24}px 16px;">
<table class="nl-content" role="presentation" width="${d.layout.contentWidth}" cellpadding="0" cellspacing="0" style="width:100%;max-width:${d.layout.contentWidth}px;">
<tr><td class="nl-card" style="background:${d.colors.background};border-radius:${d.layout.cardRadius}px;padding:${pad}px;">
${inner}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
