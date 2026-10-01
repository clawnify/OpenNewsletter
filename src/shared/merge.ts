/**
 * Merge tags: `{{first_name}}`, `{{last_name}}` and `{{email}}`, each with an
 * optional fallback for an empty value: `{{first_name|there}}`.
 *
 * Values come from subscribers, and the signup form is public, so a value is
 * never parsed as Markdown or HTML: a first name of `[Win](https://…)` must
 * arrive as text, not as a link. `fillTags` therefore swaps each tag for an
 * inert marker, lets the caller render the field, then puts the escaped value
 * where the marker landed. A tag outside this set is left as written, so a
 * typo shows in the preview instead of vanishing.
 */
import type { Block } from "./types";

export interface MergeValues {
  first_name: string;
  last_name: string;
  email: string;
}

/** What the editor's preview and a test send to an unknown address show. */
export const SAMPLE_VALUES: MergeValues = { first_name: "Alex", last_name: "Rivera", email: "alex@example.com" };

const TAG = /\{\{\s*(first_name|last_name|email)\s*(?:\|([^{}]*))?\}\}/g;
const MARK = /\u0001(\d+)\u0001/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function valueFor(values: MergeValues, field: string, fallback: string | undefined): string {
  return (values[field as keyof MergeValues] || "").trim() || (fallback ?? "").trim();
}

/**
 * Render `src` with `render`, then fill its tags with HTML-escaped values.
 * Without `values` the field renders untouched, tags and all.
 */
export function fillTags(src: string, values: MergeValues | undefined, render: (s: string) => string): string {
  if (!values || !src) return render(src);
  const filled: string[] = [];
  const marked = src.replace(TAG, (m, field: string, fallback: string | undefined, at: number) => {
    // A tag that opens a link or image target would let the reader choose the
    // whole URL, scheme included. It stays as written.
    if (/\]\(\s*$/.test(src.slice(Math.max(0, at - 8), at))) return m;
    filled.push(escapeHtml(valueFor(values, field, fallback)));
    return `\u0001${filled.length - 1}\u0001`;
  });
  if (filled.length === 0) return render(src);
  return render(marked).replace(MARK, (_m, i: string) => filled[Number(i)] ?? "");
}

/** A subject line: plain text, one line, so a value can't add a header. */
export function fillSubject(src: string, values: MergeValues | undefined): string {
  if (!values) return src;
  return fillTagsText(src, values).replace(/[\r\n]+/g, " ");
}

/**
 * Plain-text substitution, for previews rendered by React (which escapes on
 * its own). Only for trusted values such as SAMPLE_VALUES: the result may be
 * parsed as Markdown afterwards.
 */
export function fillTagsText(src: string, values: MergeValues): string {
  return (src || "").replace(TAG, (_m, field: string, fallback: string | undefined) => valueFor(values, field, fallback));
}

/** Every text field of every block, filled with trusted values (see fillTagsText). */
export function fillBlocksText(blocks: Block[], values: MergeValues): Block[] {
  const f = (s: string) => fillTagsText(s, values);
  return blocks.map((b): Block => {
    switch (b.type) {
      case "heading": return { ...b, text: f(b.text) };
      case "text": return { ...b, md: f(b.md) };
      case "image": return { ...b, caption: f(b.caption) };
      case "button": return { ...b, text: f(b.text) };
      case "list": return { ...b, items: b.items.map(f) };
      case "quote": return { ...b, text: f(b.text), cite: f(b.cite) };
      case "columns": return { ...b, items: b.items.map((c) => ({ ...c, heading: f(c.heading), text: f(c.text) })) };
      default: return b;
    }
  });
}
