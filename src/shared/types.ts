import type { DesignTokens } from "./design";

// ── Block model (newsletter body) ────────────────────────────────────
// Real newsletters are a single vertical column of blocks (see the
// reference examples). Each block renders as one email table row.
// `columns` is the one multi-column block and stacks on mobile.

export interface BlockBase {
  id: string;
}
/** Which design-guideline color a text block uses (resolved from tokens). */
export type TextColor = "default" | "primary" | "secondary";

export type Block =
  // A heading. level 1 = display/title (also the email subject source).
  | (BlockBase & { type: "heading"; level: 1 | 2 | 3; text: string; align?: "left" | "center" })
  // Body / styled text. Eyebrow & subtitle are just text with color + scale.
  | (BlockBase & {
      type: "text";
      md: string;
      color?: TextColor;
      /** Font-size multiplier of the body size (1 = body, 0.82 = eyebrow, 1.25 = deck). */
      scale?: number;
      uppercase?: boolean;
      italic?: boolean;
      align?: "left" | "center";
    })
  | (BlockBase & { type: "image"; src: string; alt: string; caption: string; href: string })
  | (BlockBase & { type: "button"; text: string; href: string; align: "left" | "center" | "right" })
  | (BlockBase & { type: "list"; ordered: boolean; items: string[] })
  | (BlockBase & { type: "quote"; text: string; cite: string })
  | (BlockBase & { type: "divider" })
  | (BlockBase & { type: "spacer"; size: number })
  | (BlockBase & { type: "columns"; items: ColumnCell[] });

export type BlockType = Block["type"];

/** One cell of a `columns` block — a compact feature card. */
export interface ColumnCell {
  image: string;
  heading: string;
  text: string;
}

/** A newsletter mail — the core editable unit (Ghost calls this a "post"). */
export interface Mail {
  id: number;
  /** Publication eyebrow, e.g. "THE EDITORIAL REVIEW • VOLUME XXIII". */
  eyebrow: string;
  title: string;
  /** Deck / standfirst (Ghost: custom_excerpt). */
  subtitle: string;
  byline_name: string;
  /** ISO date shown in the byline; the send date is `sent_at`. */
  byline_date: string;
  feature_image: string;
  /** Body as an ordered list of blocks. AI-generated, hand-editable. */
  blocks: Block[];
  /** Per-mail DESIGN.md token overrides (merged onto template/default). */
  design: DesignTokens | null;
  /** Mobile-only partial overrides, layered on `design` when viewing/editing mobile. */
  design_mobile: Partial<DesignTokens> | null;
  template_slug: string | null;
  /** Resend audience this mail sends to. */
  audience_id: string | null;
  status: "draft" | "scheduled" | "sent";
  /** Resend broadcast id once created. */
  broadcast_id: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A reusable look + content skeleton. Built-ins are seeded; users "Save as..". */
export interface Template {
  id: number;
  slug: string;
  name: string;
  description: string;
  design: DesignTokens;
  skeleton: TemplateSkeleton;
  builtin: boolean;
}

export interface TemplateSkeleton {
  eyebrow: string;
  title: string;
  subtitle: string;
  byline_name: string;
  byline_date: string;
  feature_image: string;
  blocks: Block[];
}

/** A reusable from-address. The email's domain must be verified in Resend. */
export interface Sender {
  name: string;
  email: string;
}

/** Single-row app configuration. */
export interface Settings {
  publication_name: string;
  /** Publication logo URL shown atop the masthead. */
  logo: string;
  from_name: string;
  from_email: string;
  /** Saved from-addresses the user can send/test from. */
  senders: Sender[];
  default_audience_id: string | null;
  footer_text: string;
}

/** Connection / capability status surfaced to the UI. */
export interface StatusInfo {
  resend_connected: boolean;
  ai_available: boolean;
  github_connected: boolean;
  /** A CRM in the same workspace is reachable; enables "Import from CRM". */
  crm_connected?: boolean;
  audiences: ResendAudience[];
}

export interface ResendAudience {
  id: string;
  name: string;
  contact_count?: number;
  /** Confirmed subscribers, as reported by /api/status. */
  subscribed_count?: number;
}

/**
 * A subscriber. Named for Resend historically; contacts are now stored locally
 * in D1 (see server/contacts.ts) and this shape mirrors that table — the name
 * is left alone only to avoid churning every import in one pass.
 */
export interface ResendContact {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  /**
   * Consent state. Replaces the old boolean `unsubscribed`: "not unsubscribed"
   * and "confirmed opt-in" are different things, and only `subscribed` is ever
   * mailed. `pending` means they signed up but never clicked the confirmation.
   */
  status?: "pending" | "subscribed" | "unsubscribed" | "bounced";
  consent_source?: string;
  consent_at?: string | null;
  /** Set when imported from the workspace CRM; the CRM keeps the person. */
  crm_contact_id?: string | null;
  created_at?: string;
}
