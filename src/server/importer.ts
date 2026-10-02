/**
 * Subscriber import (CSV from another platform, or this app's own export) and
 * export.
 *
 * The browser parses and maps the file (src/shared/import-map.ts) and posts it
 * here in chunks of at most IMPORT_CHUNK rows. Each chunk is a handful of
 * statements that carry the rows as one JSON parameter (`json_each`), so the
 * bound-parameter cap never limits a chunk's size.
 *
 * Consent rules, the reason this file exists rather than a loop over addContact:
 * - Someone unsubscribed, bounced or complained on the old platform arrives
 *   suppressed, and that also suppresses a pending or subscribed row already
 *   here. Honouring an opt-out is always safe; mailing past one never is.
 * - Someone subscribed on the old platform becomes `subscribed` only when the
 *   operator states how they agreed (or the row carries its own evidence, as
 *   this app's export does). Otherwise they land `pending` and get a
 *   confirmation email like anyone added by hand.
 * - A row already here never loses consent: subscribed stays subscribed with
 *   its first record, unsubscribed and bounced stay as they are.
 * - Imports never start a welcome flow: flows enroll on a signup confirming,
 *   and `import` is not a default trigger source (see flows.ts).
 */
import { query, run } from "./db";
import type { ImportRow } from "../shared/import-map";

export const IMPORT_CHUNK = 500;
export const MIN_EVIDENCE = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = new Set(["subscribed", "pending", "unsubscribed", "bounced"]);

export interface ImportOutcome {
  /** New rows, by the status they landed in. */
  added: { subscribed: number; pending: number; unsubscribed: number; bounced: number };
  /** Pending rows here that the import's consent made subscribed. */
  confirmed: number;
  /** Pending or subscribed rows here that the import's opt-out suppressed. */
  suppressed: number;
  /** Rows already here that the import left as they were. */
  unchanged: number;
  /** Rows refused, with the reason (bad email, duplicate in the chunk). */
  rejected: { email: string; reason: string }[];
}

type Clean = { e: string; f: string; l: string; s: ImportRow["status"]; at: string | null; ev: string };

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** Validate a chunk at the trust boundary. Never trusts the browser's mapping. */
export function cleanRows(input: unknown, evidence: string, source: string): { rows: Clean[]; rejected: ImportOutcome["rejected"] } {
  const rows: Clean[] = [];
  const rejected: ImportOutcome["rejected"] = [];
  const seen = new Set<string>();
  if (!Array.isArray(input)) return { rows, rejected };
  for (const r of input as Partial<ImportRow>[]) {
    const e = clip(r?.email, 320).toLowerCase();
    if (!EMAIL_RE.test(e)) {
      rejected.push({ email: e || "(blank)", reason: "not an email address" });
      continue;
    }
    if (seen.has(e)) {
      rejected.push({ email: e, reason: "appears twice in the file" });
      continue;
    }
    seen.add(e);
    const s = STATUSES.has(r?.status as string) ? (r!.status as ImportRow["status"]) : "pending";
    const at = typeof r?.opted_in_at === "string" && !Number.isNaN(Date.parse(r.opted_in_at)) ? new Date(r.opted_in_at).toISOString() : null;
    const rowEvidence = clip(r?.evidence, 1000);
    // Subscribed needs consent someone stated: the row's own record, or the
    // operator's sentence for the whole file. Without it: pending.
    const ev = rowEvidence.length >= MIN_EVIDENCE ? rowEvidence : evidence.length >= MIN_EVIDENCE ? `${evidence} (${source})` : "";
    rows.push({
      e,
      f: clip(r?.first_name, 200),
      l: clip(r?.last_name, 200),
      s: s === "subscribed" && !ev ? "pending" : s,
      at,
      ev: s === "subscribed" ? ev : "",
    });
  }
  return { rows, rejected };
}

export async function importChunk(audienceId: string, rows: Clean[], nowIso = new Date().toISOString()): Promise<Omit<ImportOutcome, "rejected">> {
  const out = { added: { subscribed: 0, pending: 0, unsubscribed: 0, bounced: 0 }, confirmed: 0, suppressed: 0, unchanged: 0 };
  if (!rows.length) return out;
  const existing = new Map(
    ((await query(
      `SELECT email, status FROM contacts
        WHERE audience_id = ? AND email IN (SELECT json_extract(value, '$.e') FROM json_each(?))`,
      [audienceId, JSON.stringify(rows.map((r) => ({ e: r.e })))],
    )) as unknown as { email: string; status: string }[]).map((r) => [r.email, r.status]),
  );

  const fresh = rows.filter((r) => !existing.has(r.e));
  const optOut = rows.filter((r) => existing.has(r.e) && (r.s === "unsubscribed" || r.s === "bounced"));
  const consent = rows.filter((r) => existing.has(r.e) && r.s === "subscribed");

  for (const r of fresh) out.added[r.s]++;
  for (const r of rows) {
    if (!existing.has(r.e)) continue;
    const was = existing.get(r.e);
    if ((r.s === "unsubscribed" || r.s === "bounced") && (was === "pending" || was === "subscribed")) out.suppressed++;
    else if (r.s === "subscribed" && was === "pending") out.confirmed++;
    else out.unchanged++;
  }

  if (fresh.length) {
    await run(
      `INSERT OR IGNORE INTO contacts
         (id, audience_id, email, first_name, last_name, status,
          consent_source, consent_at, consent_evidence, unsubscribed_at)
       SELECT 'con_' || lower(hex(randomblob(16))), ?,
              json_extract(value, '$.e'), json_extract(value, '$.f'), json_extract(value, '$.l'),
              json_extract(value, '$.s'), 'import',
              CASE WHEN json_extract(value, '$.s') = 'subscribed'
                   THEN COALESCE(json_extract(value, '$.at'), ?) END,
              json_extract(value, '$.ev'),
              CASE WHEN json_extract(value, '$.s') = 'unsubscribed' THEN ? END
         FROM json_each(?)`,
      [audienceId, nowIso, nowIso, JSON.stringify(fresh)],
    );
  }
  for (const status of ["unsubscribed", "bounced"] as const) {
    const emails = optOut.filter((r) => r.s === status).map((r) => r.e);
    if (!emails.length) continue;
    await run(
      `UPDATE contacts SET status = ?, unsubscribed_at = CASE WHEN ? = 'unsubscribed' THEN ? ELSE unsubscribed_at END
        WHERE audience_id = ? AND status IN ('pending', 'subscribed')
          AND email IN (SELECT value FROM json_each(?))`,
      [status, status, nowIso, audienceId, JSON.stringify(emails)],
    );
  }
  if (consent.length) {
    const j = JSON.stringify(consent);
    await run(
      `UPDATE contacts
          SET status = 'subscribed', consent_source = 'import',
              consent_at = COALESCE((SELECT json_extract(j.value, '$.at') FROM json_each(?) j
                                      WHERE json_extract(j.value, '$.e') = contacts.email), ?),
              consent_evidence = (SELECT json_extract(j.value, '$.ev') FROM json_each(?) j
                                   WHERE json_extract(j.value, '$.e') = contacts.email)
        WHERE audience_id = ? AND status = 'pending'
          AND email IN (SELECT json_extract(value, '$.e') FROM json_each(?))`,
      [j, nowIso, j, audienceId, j],
    );
  }
  // Fill names nobody has typed yet; never overwrite one.
  const named = rows.filter((r) => existing.has(r.e) && (r.f || r.l));
  if (named.length) {
    const j = JSON.stringify(named);
    await run(
      `UPDATE contacts
          SET first_name = CASE WHEN first_name = '' THEN COALESCE((SELECT json_extract(j.value, '$.f') FROM json_each(?) j
                                 WHERE json_extract(j.value, '$.e') = contacts.email), '') ELSE first_name END,
              last_name = CASE WHEN last_name = '' THEN COALESCE((SELECT json_extract(j.value, '$.l') FROM json_each(?) j
                                 WHERE json_extract(j.value, '$.e') = contacts.email), '') ELSE last_name END
        WHERE audience_id = ? AND (first_name = '' OR last_name = '')
          AND email IN (SELECT json_extract(value, '$.e') FROM json_each(?))`,
      [j, j, audienceId, j],
    );
  }
  return out;
}

export const EXPORT_COLUMNS = [
  "email",
  "first_name",
  "last_name",
  "status",
  "consent_source",
  "consent_at",
  "consent_evidence",
  "unsubscribed_at",
  "created_at",
] as const;

/** One page of an audience for export, in a stable order (keyset on id). */
export async function exportPage(audienceId: string, afterId: string, limit: number): Promise<Record<string, string | null>[]> {
  return (await query(
    `SELECT id, ${EXPORT_COLUMNS.join(", ")} FROM contacts
      WHERE audience_id = ? AND id > ? ORDER BY id LIMIT ?`,
    [audienceId, afterId, limit],
  )) as unknown as Record<string, string | null>[];
}
