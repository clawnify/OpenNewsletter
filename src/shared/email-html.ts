/**
 * Hygiene for author-written HTML blocks, run before the HTML goes into an
 * email or the editor preview.
 *
 * This is not the security boundary. The editor shows HTML blocks in a
 * sandboxed iframe with scripts off, the server preview is served with a CSP
 * that forbids scripts, and mail clients don't run them. What this does is
 * keep an email from carrying what clients strip or flag anyway (scripts,
 * event handlers, embeds), and keep a snippet with an unclosed tag from
 * swallowing the blocks after it. Comments stay, since Outlook's conditional
 * comments (`<!--[if mso]>`) are how email HTML targets it.
 */

const DROP_WITH_CONTENT = /<(script|iframe|object|frameset|applet|noscript)\b[\s\S]*?<\/\1\s*>/gi;
/** An opener with no closer: everything after it would be swallowed by the parser. */
const DROP_UNCLOSED = /<(script|iframe|object|frameset|applet|noscript)\b[\s\S]*$/i;
const DROP_TAG = /<\/?(embed|frame|base|meta|link)\b[^>]*>/gi;
const OPEN_TAG = /<[a-zA-Z][^>]*>/g;
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const SCRIPT_URL = /\b(href|src|action|formaction)\s*=\s*(["']?)\s*(?:javascript|vbscript|data:text\/html)[^"'\s>]*/gi;

export function cleanEmailHtml(html: string): string {
  return (html || "")
    .replace(DROP_WITH_CONTENT, "")
    .replace(DROP_UNCLOSED, "")
    .replace(DROP_TAG, "")
    .replace(OPEN_TAG, (tag) => tag.replace(EVENT_ATTR, "").replace(SCRIPT_URL, "$1=$2#"));
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

/**
 * Close what the snippet left open and drop closers it never opened, so the
 * block stays inside its own table cell.
 */
export function balanceTags(html: string): string {
  const open: string[] = [];
  const out = (html || "").replace(TOKEN, (token, closing: string | undefined, rawName: string | undefined, selfClosing: string | undefined) => {
    if (!rawName) return token; // a comment
    const name = rawName.toLowerCase();
    if (VOID.has(name) || selfClosing) return token;
    if (!closing) {
      open.push(name);
      return token;
    }
    const at = open.lastIndexOf(name);
    if (at === -1) return "";
    const implied = open.splice(at).slice(1).reverse();
    return implied.map((n) => `</${n}>`).join("") + token;
  });
  return out + open.reverse().map((n) => `</${n}>`).join("");
}
