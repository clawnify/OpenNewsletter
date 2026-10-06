/**
 * Deliverability preflight: what an operator can still fix before a send,
 * checked against the issue as it will actually go out.
 *
 * Each check rests on a published source, so a later change should keep it
 * to what that source says (all read 2026-10-06):
 * - Domain: Resend's statuses, see ../shared/sending-domain.ts.
 * - DMARC: Gmail requires it of anyone sending 5,000+ a day, and `p=none` is
 *   enough (https://support.google.com/a/answer/81126). The record is found
 *   the way RFC 9989 does (see findDmarc).
 * - Size: Gmail clips an email whose HTML passes about 102 KB. Google doesn't
 *   publish the number; every ESP measures the same one. Warned from 85 KB.
 * - Embedded images: Gmail shows no `data:` image on any platform
 *   (caniemail.com image-base64, retested 2024-05), and they count toward
 *   the clip size.
 *
 * Only a domain that can't send blocks a send, and the send route enforces
 * that on its own (sendableStatus). Everything else here is advice, a "fail"
 * included: it says the mail won't arrive well, not that it can't go out.
 */
import { sendableStatus } from "../shared/sending-domain";
import type { Check } from "../shared/types";

export interface ProviderDomain {
  id?: string;
  name: string;
  status: string;
  clickTracking?: boolean;
}

/** One DNS record of a provider domain: `record` is what it is for (SPF, DKIM, Receiving, Tracking). */
export interface DomainRecord {
  record: string;
  type: string;
  status: string;
}

export function domainCheck(
  fromDomain: string,
  domain: ProviderDomain | null,
  /** Null when the provider couldn't say. */
  records: DomainRecord[] | null,
): Check {
  const title = "Sending domain";
  if (!domain) {
    return { id: "domain", level: "fail", title, detail: `${fromDomain} isn't a sending domain on your Resend account, so nothing can be sent from it.` };
  }
  if (!sendableStatus(domain.status)) {
    return { id: "domain", level: "fail", title, detail: `${domain.name} isn't verified on Resend yet (${domain.status.replace(/_/g, " ")}).` };
  }
  const verified = domain.status.toLowerCase() === "verified";
  if (!records) {
    // "verified" covers every record. Anything short of it, unread, is no pass.
    return verified
      ? { id: "domain", level: "ok", title, detail: `${domain.name} is verified: SPF and DKIM pass.` }
      : { id: "domain", level: "unknown", title, detail: `Resend reports ${domain.name} as ${domain.status.replace(/_/g, " ")}, and its records couldn't be read to say which part.` };
  }
  // Per record: the domain's own status also covers receiving, which has
  // nothing to do with this send. Resend's older SPF is a TXT and an MX, and
  // both must verify; newer domains get two CNAMEs, and one verified is
  // enough to send (the other is a fallback).
  const missing = ["SPF", "DKIM"].filter((kind) => {
    const of = records.filter((r) => r.record === kind);
    if (!of.length) return false;
    const ok = (r: DomainRecord) => r.status === "verified";
    return of.every((r) => r.type === "CNAME") ? !of.some(ok) : !of.every(ok);
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
    .map((a) => (a.data.match(/"((?:[^"\\]|\\.)*)"/g) || [a.data]).map(unquote).join(""));
};

/** One quoted DNS character-string: `\DDD` is a decimal byte, `\X` is X. */
function unquote(s: string): string {
  return s
    .replace(/^"|"$/g, "")
    .replace(/\\(\d{3}|.)/g, (_, e: string) => (e.length === 3 ? String.fromCharCode(Number(e)) : e));
}

export interface DmarcRecord {
  /** Where it was found: the From domain itself or a parent. */
  at: string;
  tags: Record<string, string>;
}

/**
 * The DMARC record that governs `domain`, found as RFC 9989 does: its own
 * `_dmarc` record first, then a walk up the tree to the top-level label,
 * taking the nearest record. A name with more than 8 labels jumps to its last
 * 7 after the first query, so the walk never makes more than 8 lookups.
 * Several DMARC records at one name are discarded.
 */
export async function findDmarc(domain: string, resolve: ResolveTxt): Promise<DmarcRecord | null> {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (!labels.length) return null;
  const names = [labels.join(".")];
  for (let i = labels.length > 8 ? labels.length - 7 : 1; i < labels.length; i++) names.push(labels.slice(i).join("."));
  for (const at of names) {
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
  // DMARC passes when either DKIM or SPF aligns with the From domain. Resend
  // signs d=<the verified domain> and bounces through send.<that domain>.
  // Strict DKIM fails when the From address is on a subdomain of it; strict
  // SPF always fails (send.x is never the From domain). Relaxed, both pass.
  // Only both strict breaks it, and an enforcing policy then acts on that.
  const strict = (tag: string) => found.tags[tag]?.toLowerCase() === "s";
  const strictBreaks = strict("adkim") && strict("aspf") && !!signing && signing.toLowerCase() !== fromDomain.toLowerCase();
  if (strictBreaks && policy !== "none") {
    return {
      id: "dmarc",
      level: "fail",
      title,
      detail: `${found.at}'s DMARC record asks for strict alignment (adkim=s, aspf=s) with p=${policy}, and mail from ${fromDomain} is signed as ${signing}. It will fail DMARC. Send from @${signing}, or relax the record to adkim=r.`,
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

/** Where Gmail clips. Decimal, the lower reading of "102 KB". */
export const GMAIL_CLIP_BYTES = 102_000;
/**
 * Where to start warning. Klaviyo's editor calls under 85 KB safe (its
 * "Email Size" check, help.klaviyo.com/hc/en-us/articles/115000591251), and
 * what is measured here is before the provider adds tracking.
 */
export const CLIP_MARGIN_BYTES = 85_000;

export function sizeCheck(html: string, clickTracking: boolean): Check {
  const bytes = new TextEncoder().encode(html).length;
  const kb = (n: number) => `${Math.round(n / 1000)} KB`;
  const tracking = clickTracking ? " Resend's click tracking makes every link longer when it sends, so leave some room." : "";
  const title = "Email size";
  if (bytes >= GMAIL_CLIP_BYTES) {
    return {
      id: "size",
      level: "warn",
      title,
      detail: `${kb(bytes)}. Gmail cuts emails over about ${kb(GMAIL_CLIP_BYTES)}: readers see "[Message clipped]" and the rest, unsubscribe link included, sits behind a click. Shorten it or split it.${tracking}`,
    };
  }
  if (bytes >= CLIP_MARGIN_BYTES) {
    return { id: "size", level: "warn", title, detail: `${kb(bytes)}, close to the ~${kb(GMAIL_CLIP_BYTES)} where Gmail clips. Links and personal details added at send can push it over.${tracking}` };
  }
  return { id: "size", level: "ok", title, detail: `${kb(bytes)} of the ~${kb(GMAIL_CLIP_BYTES)} Gmail shows before clipping.${tracking}` };
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
