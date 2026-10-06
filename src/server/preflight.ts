/**
 * Deliverability preflight: what an operator can still fix before a send,
 * checked against the issue as it will actually go out.
 *
 * Each check rests on a published source, so a later change should keep it
 * to what that source says (all read 2026-10-06):
 * - Domain: Resend's statuses, see ../shared/sending-domain.ts.
 * - DMARC: Gmail requires it of anyone sending 5,000+ a day, and `p=none` is
 *   enough (https://support.google.com/a/answer/81126). The record is found
 *   by walking up from the From domain, as RFC 9989 does, at most 8 lookups.
 * - Size: Gmail clips an email whose HTML passes about 102 KB. Google doesn't
 *   publish the number; every ESP measures the same one.
 * - Embedded images: Gmail shows no `data:` image on any platform
 *   (caniemail.com image-base64, retested 2024-05), and they count toward
 *   the clip size.
 *
 * Only the domain check blocks a send, and the send route enforces that on
 * its own (sendableStatus). Everything here is advice.
 */
import { sendableStatus } from "../shared/sending-domain";
import type { Check } from "../shared/types";

export interface ProviderDomain {
  id?: string;
  name: string;
  status: string;
  clickTracking?: boolean;
}

export function domainCheck(
  fromDomain: string,
  domain: ProviderDomain | null,
  records: { record: string; status: string }[] | null,
): Check {
  const title = "Sending domain";
  if (!domain) {
    return { id: "domain", level: "fail", title, detail: `${fromDomain} isn't a sending domain on your Resend account, so nothing can be sent from it.` };
  }
  if (!sendableStatus(domain.status)) {
    return { id: "domain", level: "fail", title, detail: `${domain.name} isn't verified on Resend yet (${domain.status.replace(/_/g, " ")}).` };
  }
  // Per record when the provider can say: the domain's own status also
  // covers receiving, which has nothing to do with this send. A kind counts
  // as working when any of its records is verified: with two sending
  // records, one is a fallback and Resend sends on either.
  const missing = ["SPF", "DKIM"].filter((kind) => {
    const of = (records || []).filter((r) => r.record === kind);
    return of.length > 0 && !of.some((r) => r.status === "verified");
  });
  if (missing.length) {
    return { id: "domain", level: "warn", title, detail: `${domain.name}: ${missing.join(" and ")} not verified on Resend yet. Mail may be refused or land in spam until it is.` };
  }
  if (domain.status.toLowerCase() === "temporary_failure") {
    return { id: "domain", level: "warn", title, detail: `Resend can't see ${domain.name}'s DNS records right now. It rechecks for 72 hours before the domain fails.` };
  }
  return { id: "domain", level: "ok", title, detail: `${domain.name} is verified: SPF and DKIM pass.` };
}

// ── DMARC ────────────────────────────────────────────────────────────

export type ResolveTxt = (name: string) => Promise<string[]>;

/** TXT lookup over DNS-over-HTTPS; a Worker has no resolver of its own. Throws when the lookup fails. */
export const dohTxt: ResolveTxt = async (name) => {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`DNS ${res.status}`);
  const json = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
  // 3 is NXDOMAIN: the name doesn't exist, which is an answer, not a failure.
  if (json.Status !== 0 && json.Status !== 3) throw new Error(`DNS status ${json.Status}`);
  // A TXT value arrives as one or more quoted strings that join into one record.
  return (json.Answer || [])
    .filter((a) => a.type === 16)
    .map((a) => (a.data.match(/"((?:[^"\\]|\\.)*)"/g) || [a.data]).map((s) => s.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1")).join(""));
};

export interface DmarcRecord {
  /** Where it was found: the From domain itself or a parent. */
  at: string;
  tags: Record<string, string>;
}

/**
 * The DMARC record that governs `domain`: its own `_dmarc` record, else the
 * nearest parent's. Several records at one name are discarded, as RFC 9989
 * says. Stops before the top-level label, and after 8 lookups.
 */
export async function findDmarc(domain: string, resolve: ResolveTxt): Promise<DmarcRecord | null> {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  for (let i = 0; i < labels.length - 1 && i < 8; i++) {
    const at = labels.slice(i).join(".");
    const found = (await resolve(`_dmarc.${at}`)).filter((t) => /^v\s*=\s*DMARC1\s*(;|$)/i.test(t.trim()));
    if (found.length === 1) return { at, tags: parseTags(found[0]) };
  }
  return null;
}

function parseTags(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) tags[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return tags;
}

export function dmarcCheck(fromDomain: string, signing: string | null, found: DmarcRecord | null | "error"): Check {
  const title = "DMARC";
  if (found === "error") {
    return { id: "dmarc", level: "unknown", title, detail: "Couldn't look up the DMARC record right now." };
  }
  if (!found) {
    return {
      id: "dmarc",
      level: "warn",
      title,
      detail: "No DMARC record. Gmail and Yahoo require one from anyone sending 5,000 or more emails a day, and p=none is enough. Add this record where you manage DNS:",
      record: { name: `_dmarc.${signing || fromDomain}`, type: "TXT", value: "v=DMARC1; p=none;" },
    };
  }
  const own = found.at === fromDomain.toLowerCase();
  const policy = ((own ? found.tags.p : found.tags.sp || found.tags.p) || "none").toLowerCase();
  // Resend signs with d=<the verified domain> and returns mail through
  // send.<domain>, so only relaxed alignment passes when the From address
  // is on a subdomain. Under strict DKIM alignment the message fails DMARC,
  // and an enforcing policy then quarantines or rejects it.
  const strictBreaks = found.tags.adkim?.toLowerCase() === "s" && !!signing && signing.toLowerCase() !== fromDomain.toLowerCase();
  if (strictBreaks && policy !== "none") {
    return {
      id: "dmarc",
      level: "fail",
      title,
      detail: `${found.at}'s DMARC record asks for strict alignment (adkim=s) with p=${policy}, and mail from ${fromDomain} is signed as ${signing}. It will fail DMARC. Send from @${signing}, or relax the record to adkim=r.`,
    };
  }
  const where = own ? "" : ` (from ${found.at})`;
  return {
    id: "dmarc",
    level: "ok",
    title,
    detail: policy === "none" ? `Set up, monitoring only (p=none)${where}. That meets Gmail and Yahoo's rule.` : `Set up and enforced (p=${policy})${where}.`,
  };
}

// ── content ──────────────────────────────────────────────────────────

/** Where Gmail clips. Decimal, the lower reading of "102 KB", so the warning comes early rather than late. */
export const GMAIL_CLIP_BYTES = 102_000;

export function sizeCheck(html: string, clickTracking: boolean): Check {
  const bytes = new TextEncoder().encode(html).length;
  const kb = (n: number) => `${Math.round(n / 1000)} KB`;
  const tracking = clickTracking ? " Resend's click tracking makes every link longer when it sends, so leave some room." : "";
  if (bytes >= GMAIL_CLIP_BYTES) {
    return {
      id: "size",
      level: "warn",
      title: "Email size",
      detail: `${kb(bytes)}. Gmail cuts emails over about ${kb(GMAIL_CLIP_BYTES)}: readers see "[Message clipped]" and the rest, unsubscribe link included, sits behind a click. Shorten it or split it.${tracking}`,
    };
  }
  return { id: "size", level: "ok", title: "Email size", detail: `${kb(bytes)} of the ~${kb(GMAIL_CLIP_BYTES)} Gmail shows before clipping.${tracking}` };
}

export function imagesCheck(html: string): Check {
  const embedded = (html.match(/<img\b[^>]*\bsrc\s*=\s*["']?\s*data:/gi) || []).length;
  if (embedded) {
    return {
      id: "images",
      level: "warn",
      title: "Images",
      detail: `${embedded} image${embedded === 1 ? " is" : "s are"} embedded in the email itself. Gmail doesn't show embedded images, and they make the email heavier. Upload ${embedded === 1 ? "it" : "them"} instead.`,
    };
  }
  return { id: "images", level: "ok", title: "Images", detail: "All images are linked, not embedded." };
}
