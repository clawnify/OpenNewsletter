/**
 * DESIGN.md token model — the single source of truth for how a
 * newsletter looks. Follows the Google Labs DESIGN.md spec
 * (https://github.com/google-labs-code/design.md): a small set of
 * named tokens that fully describe a brand.
 *
 * The same token object drives three surfaces:
 *   1. The right-hand design panel (Basic/Advanced tabs).
 *   2. The live preview canvas (via `designToCss`).
 *   3. The sent email HTML (via the server renderer, same `designToCss`).
 *
 * A template = a `DesignTokens` object + a content skeleton.
 * "Save as.." exports the current tokens; `serializeDesign` renders
 * them back to a DESIGN.md file for portability.
 */
import chroma from "chroma-js";

// ── Token shape ──────────────────────────────────────────────────────

export interface DesignTokens {
  colors: {
    /** Outer page behind the content card (e.g. light gray). */
    page: string;
    /** Content surface where text sits — the card (often white). */
    background: string;
    /** Default body + heading text ("text on background"). */
    foreground: string;
    /** Accent: rules, the publication eyebrow, button fills. */
    primary: string;
    /** Text/icons on a `primary` surface. */
    onPrimary: string;
    /** Secondary copy: deck, byline, captions, footer. */
    secondary: string;
    /** Inline link color. */
    link: string;
    /** Hairlines and dividers. */
    border: string;
  };
  typography: {
    /** Font for the title + section headings (editorial → serif). */
    headingFont: FontKey;
    /** Font for body copy. */
    bodyFont: FontKey;
    /** Body font size in px. */
    baseSize: number;
    /** Title (display) font size in px. */
    titleSize: number;
    /** Body line-height (unitless). */
    lineHeight: number;
    /** Heading weight (400–800). */
    headingWeight: number;
  };
  layout: {
    /** Max content width in px (email-safe: 480–680). */
    contentWidth: number;
    /** Base vertical rhythm between blocks in px. */
    spacing: number;
    /** Corner radius for images in px. */
    imageRadius: number;
    /** Corner radius for buttons in px. */
    buttonRadius: number;
    /** Content-card corner radius in px (0 = flat, no visible card). */
    cardRadius: number;
    /** Padding between the page edge and the card in px. */
    outerPadding: number;
  };
  options: {
    /** Show the publication logo atop the masthead. */
    showHeader: boolean;
    /** Show the footer (publication + unsubscribe). */
    showFooter: boolean;
    /** Auto-pick white/black button text via contrast (else use onPrimary). */
    autoButtonText?: boolean;
    // Legacy masthead toggles (masthead is now blocks); kept for back-compat.
    showFeatureImage?: boolean;
    showByline?: boolean;
    showDivider?: boolean;
  };
}

// ── Curated font stacks (email-safe; web fonts loaded in <head>) ─────

export type FontKey =
  | "newsreader"
  | "georgia"
  | "inter"
  | "system"
  | "iowan"
  | "mono";

export const FONTS: Record<FontKey, { label: string; stack: string }> = {
  newsreader: { label: "Newsreader (serif)", stack: "'Newsreader', Georgia, 'Times New Roman', serif" },
  georgia: { label: "Georgia (serif)", stack: "Georgia, 'Times New Roman', Times, serif" },
  iowan: { label: "Iowan (serif)", stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif" },
  inter: { label: "Inter (sans)", stack: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  system: { label: "System (sans)", stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  mono: { label: "Mono", stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
};

export function fontStack(key: FontKey): string {
  return (FONTS[key] || FONTS.system).stack;
}

// ── Default brand: "Classic Editorial" (matches the studio mockup) ───

export const DEFAULT_DESIGN: DesignTokens = {
  colors: {
    page: "#FFFFFF",
    background: "#FFFFFF",
    foreground: "#111111",
    primary: "#DB2777",
    onPrimary: "#FFFFFF",
    secondary: "#6B7280",
    link: "#4746E5",
    border: "#E5E7EB",
  },
  typography: {
    headingFont: "newsreader",
    bodyFont: "newsreader",
    baseSize: 17,
    titleSize: 40,
    lineHeight: 1.65,
    headingWeight: 600,
  },
  layout: {
    contentWidth: 600,
    spacing: 24,
    imageRadius: 8,
    buttonRadius: 8,
    cardRadius: 0,
    outerPadding: 0,
  },
  options: {
    showHeader: true,
    showFooter: true,
    autoButtonText: true,
  },
};

// ── CSS custom properties (preview + email share this) ───────────────

/**
 * Render tokens to CSS custom properties. The preview canvas sets
 * these on a wrapper; the email renderer resolves them to inline
 * styles. Variable names are prefixed `--nl-` to avoid colliding
 * with the studio chrome's own theme.
 */
export function designVars(d: DesignTokens): Record<string, string> {
  return {
    "--nl-page": d.colors.page,
    "--nl-bg": d.colors.background,
    "--nl-fg": d.colors.foreground,
    "--nl-primary": d.colors.primary,
    "--nl-on-primary": d.colors.onPrimary,
    "--nl-secondary": d.colors.secondary,
    "--nl-link": d.colors.link,
    "--nl-border": d.colors.border,
    "--nl-heading-font": fontStack(d.typography.headingFont),
    "--nl-body-font": fontStack(d.typography.bodyFont),
    "--nl-base-size": `${d.typography.baseSize}px`,
    "--nl-title-size": `${d.typography.titleSize}px`,
    "--nl-line-height": `${d.typography.lineHeight}`,
    "--nl-heading-weight": `${d.typography.headingWeight}`,
    "--nl-width": `${d.layout.contentWidth}px`,
    "--nl-space": `${d.layout.spacing}px`,
    "--nl-image-radius": `${d.layout.imageRadius}px`,
    "--nl-btn-radius": `${d.layout.buttonRadius}px`,
    "--nl-card-radius": `${d.layout.cardRadius}px`,
    "--nl-outer-pad": `${d.layout.outerPadding}px`,
  };
}

/** Inline `style="--nl-bg:…; …"` string for a wrapper element. */
export function designVarsStyle(d: DesignTokens): string {
  return Object.entries(designVars(d))
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

// ── Panel metadata: drives the Basic/Advanced design panel ───────────

export type FieldType = "color" | "number" | "font" | "toggle";

export interface Field {
  /** Dotted path into DesignTokens, e.g. "colors.primary". */
  path: string;
  label: string;
  type: FieldType;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface FieldGroup {
  title: string;
  tab: "basic" | "advanced";
  fields: Field[];
}

export const DESIGN_PANEL: FieldGroup[] = [
  {
    title: "Colors",
    tab: "basic",
    fields: [
      { path: "colors.background", label: "Background", type: "color" },
      { path: "colors.foreground", label: "Text on background", type: "color" },
      { path: "colors.primary", label: "Primary", type: "color", hint: "Accent: eyebrow, buttons, links" },
      { path: "colors.secondary", label: "Secondary", type: "color", hint: "Deck, byline, captions" },
      { path: "colors.link", label: "Link text", type: "color" },
    ],
  },
  {
    title: "Typography",
    tab: "basic",
    fields: [
      { path: "typography.headingFont", label: "Heading font", type: "font" },
      { path: "typography.bodyFont", label: "Body font", type: "font" },
      { path: "typography.titleSize", label: "Title size", type: "number", min: 24, max: 72, step: 1 },
      { path: "typography.baseSize", label: "Body size", type: "number", min: 13, max: 22, step: 1 },
      { path: "typography.lineHeight", label: "Line height", type: "number", min: 1.2, max: 2, step: 0.05 },
      { path: "typography.headingWeight", label: "Heading weight", type: "number", min: 400, max: 800, step: 100 },
    ],
  },
  {
    title: "Layout",
    tab: "advanced",
    fields: [
      { path: "colors.page", label: "Page background", type: "color", hint: "Behind the content card" },
      { path: "layout.contentWidth", label: "Content width", type: "number", min: 440, max: 720, step: 10 },
      { path: "layout.cardRadius", label: "Card radius", type: "number", min: 0, max: 28, step: 1, hint: "0 = flat, no card" },
      { path: "layout.outerPadding", label: "Page padding", type: "number", min: 0, max: 48, step: 2 },
      { path: "layout.spacing", label: "Block spacing", type: "number", min: 12, max: 48, step: 2 },
      { path: "colors.border", label: "Border / divider", type: "color" },
    ],
  },
  {
    title: "Roundness",
    tab: "advanced",
    fields: [
      { path: "layout.imageRadius", label: "Image roundness", type: "number", min: 0, max: 32, step: 1 },
      { path: "layout.buttonRadius", label: "Button roundness", type: "number", min: 0, max: 32, step: 1 },
    ],
  },
  {
    title: "Buttons",
    tab: "advanced",
    fields: [
      { path: "options.autoButtonText", label: "Auto button text", type: "toggle", hint: "White or black, by contrast" },
      { path: "colors.onPrimary", label: "Custom button text", type: "color", hint: "Used when auto is off" },
    ],
  },
  {
    title: "Sections",
    tab: "advanced",
    fields: [
      { path: "options.showHeader", label: "Show logo", type: "toggle" },
      { path: "options.showFooter", label: "Footer", type: "toggle", hint: "The unsubscribe link stays either way" },
    ],
  },
];

// ── Path helpers (used by the panel to read/write nested tokens) ─────

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/** Immutably set a dotted path, returning a new object. */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const clone: any = Array.isArray(obj) ? [...(obj as any)] : { ...(obj as any) };
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = { ...cur[keys[i]] };
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return clone;
}

/** Layer a partial mobile override on top of a fully-resolved base. */
export function applyMobile(base: DesignTokens, stored?: Partial<DesignTokens> | null): DesignTokens {
  if (!stored) return base;
  const mobile = cleanTokens(stored);
  return {
    colors: { ...base.colors, ...(mobile.colors || {}) },
    typography: { ...base.typography, ...(mobile.typography || {}) },
    layout: { ...base.layout, ...(mobile.layout || {}) },
    options: { ...base.options, ...(mobile.options || {}) },
  };
}

/** Tokens in `over` that differ from `base` — the minimal mobile override to store. */
export function diffTokens(base: DesignTokens, over: DesignTokens): Partial<DesignTokens> {
  const out: Partial<DesignTokens> = {};
  for (const group of ["colors", "typography", "layout", "options"] as const) {
    const g: Record<string, unknown> = {};
    for (const k of Object.keys(over[group])) {
      if ((over[group] as any)[k] !== (base[group] as any)[k]) g[k] = (over[group] as any)[k];
    }
    if (Object.keys(g).length) (out as any)[group] = g;
  }
  return out;
}

/** The panel's range for each number token: the one place those bounds live. */
const NUMBER_RANGES: Record<string, { min: number; max: number }> = Object.fromEntries(
  DESIGN_PANEL.flatMap((g) => g.fields)
    .filter((f) => f.type === "number" && f.min !== undefined && f.max !== undefined)
    .map((f) => [f.path, { min: f.min!, max: f.max! }]),
);
const LEGACY_OPTIONS = ["showFeatureImage", "showByline", "showDivider"];

/**
 * Keep only tokens with a usable value. Tokens are written by the panel, the
 * assistant, agents over the API and imported DESIGN.md files, and they end up
 * inside style attributes and a <style> block, so a value is checked, not
 * trusted: a colour must parse as a colour, a font must be one of FONTS, a
 * number is clamped to the panel's range, an option must be a boolean.
 * Anything else is dropped, so the default (or the layer below) shows instead.
 */
export function cleanTokens(input: unknown): Partial<DesignTokens> {
  const out: Record<string, Record<string, unknown>> = {};
  if (!input || typeof input !== "object") return out;
  const src = input as Record<string, unknown>;
  const put = (group: string, key: string, value: unknown) => ((out[group] ??= {})[key] = value);
  const group = (name: string) => {
    const g = src[name];
    return g && typeof g === "object" && !Array.isArray(g) ? (g as Record<string, unknown>) : {};
  };

  for (const [k, v] of Object.entries(group("colors"))) {
    if (k in DEFAULT_DESIGN.colors && typeof v === "string" && v.length <= 64 && chroma.valid(v)) put("colors", k, v);
  }
  for (const [k, v] of Object.entries(group("typography"))) {
    if (k === "headingFont" || k === "bodyFont") {
      if (typeof v === "string" && v in FONTS) put("typography", k, v);
    } else if (k in DEFAULT_DESIGN.typography) {
      const n = clampToken(`typography.${k}`, v);
      if (n !== null) put("typography", k, n);
    }
  }
  for (const [k, v] of Object.entries(group("layout"))) {
    if (!(k in DEFAULT_DESIGN.layout)) continue;
    const n = clampToken(`layout.${k}`, v);
    if (n !== null) put("layout", k, n);
  }
  for (const [k, v] of Object.entries(group("options"))) {
    if ((k in DEFAULT_DESIGN.options || LEGACY_OPTIONS.includes(k)) && typeof v === "boolean") put("options", k, v);
  }
  return out as Partial<DesignTokens>;
}

function clampToken(path: string, v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = NUMBER_RANGES[path];
  return r ? Math.min(r.max, Math.max(r.min, n)) : n;
}

/** Merge partial (possibly stored) tokens onto the defaults, keeping only usable values. */
export function withDefaults(stored?: Partial<DesignTokens> | null): DesignTokens {
  if (!stored) return DEFAULT_DESIGN;
  const partial = cleanTokens(stored);
  return {
    colors: { ...DEFAULT_DESIGN.colors, ...(partial.colors || {}) },
    typography: { ...DEFAULT_DESIGN.typography, ...(partial.typography || {}) },
    layout: { ...DEFAULT_DESIGN.layout, ...(partial.layout || {}) },
    options: { ...DEFAULT_DESIGN.options, ...(partial.options || {}) },
  };
}

// ── DESIGN.md serializer (export / "Save as..") ──────────────────────

/**
 * Serialize tokens to a DESIGN.md file (YAML frontmatter + prose),
 * matching the Google Labs format. Lets a template authored in the
 * studio round-trip to the repo's `templates/<slug>/DESIGN.md`.
 */
export function serializeDesign(d: DesignTokens, name = "Custom", description = ""): string {
  const fm = [
    "---",
    "version: alpha",
    `name: ${name}`,
    description ? `description: ${description}` : null,
    "colors:",
    ...Object.entries(d.colors).map(([k, v]) => `  ${k}: "${v}"`),
    "typography:",
    `  headingFont: ${d.typography.headingFont}`,
    `  bodyFont: ${d.typography.bodyFont}`,
    `  baseSize: ${d.typography.baseSize}px`,
    `  titleSize: ${d.typography.titleSize}px`,
    `  lineHeight: ${d.typography.lineHeight}`,
    `  headingWeight: ${d.typography.headingWeight}`,
    "layout:",
    `  contentWidth: ${d.layout.contentWidth}px`,
    `  spacing: ${d.layout.spacing}px`,
    `  imageRadius: ${d.layout.imageRadius}px`,
    `  buttonRadius: ${d.layout.buttonRadius}px`,
    `  cardRadius: ${d.layout.cardRadius}px`,
    `  outerPadding: ${d.layout.outerPadding}px`,
    "options:",
    ...Object.entries(d.options).map(([k, v]) => `  ${k}: ${v}`),
    "---",
  ].filter(Boolean).join("\n");
  return `${fm}\n\n# ${name}\n\n${description || "A newsletter brand."}\n`;
}
