import { DEFAULT_DESIGN, withDefaults, layerTokens, type DesignTokens } from "../../shared/design";
import type { Mail, Template } from "../../shared/types";

/** The tokens a mail's own design is layered on: its template's, or the default. */
export function templateTokens(mail: Mail, templates: Template[]): DesignTokens {
  const t = templates.find((x) => x.slug === mail.template_slug);
  return t ? withDefaults(t.design) : DEFAULT_DESIGN;
}

/**
 * Base (desktop) tokens for a mail: its template, with the tokens the mail
 * changed on top. The mail stores only those changes, so a template edit
 * reaches every token the mail left alone.
 */
export function baseDesign(mail: Mail, templates: Template[]): DesignTokens {
  return layerTokens(templateTokens(mail, templates), mail.design);
}

/** Effective tokens for a device: desktop = base, mobile = base + mobile override. */
export function effectiveDesign(
  mail: Mail,
  templates: Template[],
  device: "desktop" | "mobile" = "desktop",
): DesignTokens {
  const base = baseDesign(mail, templates);
  return device === "mobile" ? layerTokens(base, mail.design_mobile) : base;
}
