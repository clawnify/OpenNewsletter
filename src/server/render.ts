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
import { fontStack, applyMobile, type DesignTokens } from "../shared/design";
import { fillTags, type MergeValues } from "../shared/merge";
import { esc, renderBlock } from "../shared/email-blocks";
import type { Block, Mail, Settings } from "../shared/types";

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
  /**
   * This subscriber's keep link, for an ask to inactive subscribers
   * (`mail.segment === 'inactive'`, src/server/sunset.ts). Such a mail always
   * shows the button, like the unsubscribe link: nobody may be removed without
   * a way to stay. Previews and test sends get a dead link.
   */
  keepUrl?: string;
  /**
   * This subscriber's merge-tag values. Omitted, tags render as written:
   * a send whose snapshot predates merge tags must render byte for byte as it
   * did, since its retries reuse idempotency keys.
   */
  merge?: MergeValues;
  /** The pre-v2 column padding, for sends begun before it changed. */
  legacyColumns?: boolean;
}

export function renderInner(mail: Mail, d: DesignTokens, settings: Settings, opts: RenderOpts = {}): string {
  const rows: string[] = [];
  const space = d.layout.spacing;
  const body = fontStack(d.typography.bodyFont);
  const logo = opts.logo || settings.logo;

  if (d.options.showHeader && logo) {
    rows.push(`<tr><td style="padding:0 0 ${space}px;"><img src="${esc(logo)}" alt="${esc(settings.publication_name)}" height="28" style="height:28px;width:auto;display:block;border:0;"></td></tr>`);
  }
  for (const b of mail.blocks || []) rows.push(`<tr><td style="padding:${space}px 0 0;">${renderBlock(b, d, opts.merge, opts.legacyColumns)}</td></tr>`);

  // No renderer version bump: only ask mails, which no earlier snapshot holds, change.
  if (mail.segment === "inactive") {
    const keep: Block = { id: "keep", type: "button", text: "Yes, keep me subscribed", href: opts.keepUrl || "#", align: "center", fullWidth: true };
    rows.push(`<tr><td style="padding:${space * 2}px 0 0;">${renderBlock(keep, d)}</td></tr>`);
  }

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

/**
 * The inbox preview line. Hidden in the body, and padded with zero-width
 * joiners and spaces so the client doesn't fill the rest of the line with
 * the first words of the body (often the eyebrow).
 */
function preheaderHtml(text: string | undefined, merge?: MergeValues): string {
  if (!text?.trim()) return "";
  const pad = "&zwnj;&nbsp;".repeat(80);
  return `<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;opacity:0;color:transparent;">${fillTags(text.trim(), merge, esc)}${pad}</div>\n`;
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
${preheaderHtml(mail.preheader, opts.merge)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${d.colors.page};">
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
