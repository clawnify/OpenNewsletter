/**
 * The send engine: one `deliveries` row per recipient, sent in batches of 100,
 * resumable after anything short of losing the database.
 *
 * It replaced a loop that posted one email per recipient inside the operator's
 * HTTP request and recorded nothing per person. That loop broke in three ways
 * that grow with the list: four parallel requests outran the provider's
 * 10 req/s default and the 429s were counted as failures and never retried;
 * closing the tab mid-send stopped it with no record of who had been mailed,
 * so a retry mailed everyone again; and the issue was marked `sent` even when
 * every recipient failed.
 *
 * The rules this module keeps:
 *
 *  - **Who gets the issue is decided once.** `beginSend` snapshots the issue
 *    (content, design, settings, sender) and writes a row per confirmed
 *    subscriber, numbered into fixed batches. Later edits to the issue, the
 *    settings or the list don't change what an in-flight send delivers.
 *  - **An attempt whose outcome is unknown is retried under the same
 *    idempotency key**, so a retry after a timeout is deduplicated by the
 *    provider instead of mailing 100 people twice. The key is stored on the
 *    batch's rows when it is claimed and kept until the batch resolves; this
 *    is also why a batch's membership never changes after its first claim.
 *    When the provider definitely sent nothing (refused, throttled) the key is
 *    dropped with the claim, so the next attempt can't be answered with a
 *    cached refusal.
 *  - **Every claim is one statement.** The storage layer runs statements one
 *    at a time with no transactions, so ownership of a batch is decided by an
 *    UPDATE's change count, never by a read followed by a write.
 *  - **"Unknown" is not "failed".** A timeout or 5xx may have delivered. Those
 *    rows stay claimed and are retried under the same key once the claim goes
 *    stale; only after MAX_ATTEMPTS are they recorded failed, with a message
 *    that says they may have arrived.
 */
import { query, get, run } from "./db";
import { renderEmailHtml } from "./render";
import type { BatchMessage, BatchOutcome, EmailProvider } from "./providers";
import type { DesignTokens } from "../shared/design";
import type { Mail, Settings } from "../shared/types";

export const BATCH_SIZE = 100;
/** A claim this old with no outcome recorded means the worker holding it died. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** Claims per batch before an unanswered row is recorded failed. */
export const MAX_ATTEMPTS = 3;
/** Longest single wait on a 429 before giving the batch back and yielding. */
const MAX_RATE_WAIT_MS = 10_000;

/** Everything a send needs, frozen at the moment it starts. */
export interface SendSnapshot {
  mail: Omit<Mail, "conversation">;
  design: DesignTokens;
  settings: Settings;
  from: string;
  /** The app's own origin, for unsubscribe links. */
  origin: string;
}

export type BeginResult =
  | { ok: true; sendId: string; resumed: boolean }
  | { ok: false; reason: "already-sent" | "not-found" };

export interface SendProgress {
  status: "sending" | "sent" | "failed";
  sent: number;
  failed: number;
  skipped: number;
  /** Rows not yet resolved: waiting, or claimed with no answer yet. */
  open: number;
  error: string | null;
}

export interface DrainOptions {
  /** Epoch ms after which to stop starting batches. Absent = run to completion. */
  deadline?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Mirrors schema.sql, for installs whose database predates the table. */
export const DELIVERIES_DDL = [
  `CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    mail_id INTEGER NOT NULL,
    contact_id TEXT NOT NULL,
    email TEXT NOT NULL,
    batch INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TEXT,
    send_key TEXT,
    provider_message_id TEXT,
    error TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_recipient ON deliveries(mail_id, contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_batch ON deliveries(mail_id, status, batch)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_provider ON deliveries(provider_message_id)
     WHERE provider_message_id IS NOT NULL`,
];

const iso = (ms: number) => new Date(ms).toISOString();
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Start a send, or pick up the one already running.
 *
 * - draft / scheduled: claimed atomically, snapshotted, recipients written.
 * - sending: resumed as-is (the snapshot is kept so in-flight batches send
 *   exactly what their first attempt sent).
 * - failed: resumed with a fresh snapshot, since a failed send stopped on
 *   something the operator was meant to fix (the key, the sender). Rows that
 *   were delivered stay delivered; only unresolved rows go out.
 * - sent: refused.
 */
export async function beginSend(mailId: number, audienceId: string, snapshot: SendSnapshot): Promise<BeginResult> {
  const sendId = crypto.randomUUID();
  const claimed = await run(
    `UPDATE mails SET status = 'sending', send_id = ?, send_snapshot = ?, send_error = NULL,
            updated_at = datetime('now')
      WHERE id = ? AND status IN ('draft', 'scheduled')`,
    [sendId, JSON.stringify(snapshot), mailId],
  );
  if (claimed.changes > 0) {
    await writeRecipients(mailId, audienceId);
    return { ok: true, sendId, resumed: false };
  }

  const row = await get<{ status: string; send_id: string | null }>(
    `SELECT status, send_id FROM mails WHERE id = ?`,
    [mailId],
  );
  if (!row) return { ok: false, reason: "not-found" };
  if (row.status === "sent") return { ok: false, reason: "already-sent" };
  if (row.status === "failed" && row.send_id) {
    await run(
      `UPDATE mails SET status = 'sending', send_snapshot = ?, send_error = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'failed'`,
      [JSON.stringify(snapshot), mailId],
    );
  }
  if ((row.status === "sending" || row.status === "failed") && row.send_id) {
    // A worker that died between the claim above and writing recipients leaves
    // a send with no rows; write them now. INSERT OR IGNORE makes a race harmless.
    await writeRecipients(mailId, audienceId);
    return { ok: true, sendId: row.send_id, resumed: true };
  }
  return { ok: false, reason: "not-found" };
}

/** One row per confirmed subscriber, numbered into fixed batches. Once per send. */
async function writeRecipients(mailId: number, audienceId: string): Promise<void> {
  const existing = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM deliveries WHERE mail_id = ?`, [mailId]);
  if ((existing?.n ?? 0) > 0) return;
  await run(
    `INSERT OR IGNORE INTO deliveries (id, mail_id, contact_id, email, batch)
     SELECT 'dlv_' || lower(hex(randomblob(16))), ?, id, email,
            CAST((ROW_NUMBER() OVER (ORDER BY created_at, id) - 1) / ? AS INTEGER)
       FROM contacts
      WHERE audience_id = ? AND status = 'subscribed'`,
    [mailId, BATCH_SIZE, audienceId],
  );
}

/**
 * Work through the send's batches until they are all resolved, the deadline
 * passes, or the provider refuses the send outright. Safe to run concurrently
 * with itself: batches are claimed, not read.
 */
export async function drainSend(mailId: number, provider: EmailProvider, opts: DrainOptions = {}): Promise<SendProgress> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const mail = await get<{ status: string; send_id: string | null; send_snapshot: string | null }>(
    `SELECT status, send_id, send_snapshot FROM mails WHERE id = ?`,
    [mailId],
  );
  if (!mail || mail.status !== "sending" || !mail.send_id || !mail.send_snapshot) return progress(mailId);
  const snap = JSON.parse(mail.send_snapshot) as SendSnapshot;
  const sendId = mail.send_id;

  for (;;) {
    if (opts.deadline !== undefined && now() >= opts.deadline) break;
    const batch = await claimNextBatch(mailId, sendId, now());
    if (batch === "none") break;
    if (batch === "lost") continue;

    const result = await sendBatch(mailId, batch, snap, provider, { now, sleep, deadline: opts.deadline });
    if (result.stop === "fatal") {
      await run(
        `UPDATE mails SET status = 'failed', send_error = ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'sending'`,
        [result.message, mailId],
      );
      return progress(mailId);
    }
    if (result.stop === "yield") break;
  }
  return finishIfDone(mailId, now());
}

type Claim = number | "none" | "lost";

/** The next batch to work on, claimed. Orphaned claims first, so a stuck batch can't starve. */
async function claimNextBatch(mailId: number, sendId: string, nowMs: number): Promise<Claim> {
  const stale = iso(nowMs - STALE_CLAIM_MS);
  const next = await get<{ batch: number; status: string }>(
    `SELECT batch, status FROM deliveries
      WHERE mail_id = ? AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?))
      ORDER BY status = 'pending', batch LIMIT 1`,
    [mailId, stale],
  );
  if (!next) return "none";

  if (next.status === "sending") {
    const took = await run(
      `UPDATE deliveries SET claimed_at = ?, attempts = attempts + 1
        WHERE mail_id = ? AND batch = ? AND status = 'sending' AND claimed_at < ?`,
      [iso(nowMs), mailId, next.batch, stale],
    );
    if (took.changes === 0) return "lost";
    await run(
      `UPDATE deliveries SET status = 'failed',
              error = 'No answer from the provider after ${MAX_ATTEMPTS} attempts. It may have been delivered.'
        WHERE mail_id = ? AND batch = ? AND status = 'sending' AND attempts > ?`,
      [mailId, next.batch, MAX_ATTEMPTS],
    );
    return next.batch;
  }

  const took = await run(
    `UPDATE deliveries SET status = 'sending', claimed_at = ?, attempts = attempts + 1, send_key = ?
      WHERE mail_id = ? AND batch = ? AND status = 'pending'`,
    [iso(nowMs), `opennewsletter/${sendId}/${next.batch}/${crypto.randomUUID().slice(0, 8)}`, mailId, next.batch],
  );
  if (took.changes === 0) return "lost";
  // First claim only: drop anyone who left since the send began. Never on a
  // re-claim, where the batch must stay exactly what its first attempt sent.
  await run(
    `UPDATE deliveries SET status = 'skipped', error = 'Unsubscribed before this issue reached them.'
      WHERE mail_id = ? AND batch = ? AND status = 'sending'
        AND contact_id NOT IN (SELECT id FROM contacts WHERE status = 'subscribed')`,
    [mailId, next.batch],
  );
  return next.batch;
}

type BatchResult = { stop?: undefined } | { stop: "fatal"; message: string } | { stop: "yield" };

async function sendBatch(
  mailId: number,
  batch: number,
  snap: SendSnapshot,
  provider: EmailProvider,
  t: { now: () => number; sleep: (ms: number) => Promise<void>; deadline?: number },
): Promise<BatchResult> {
  const rows = await query<{ id: string; contact_id: string; email: string; send_key: string }>(
    `SELECT id, contact_id, email, send_key FROM deliveries
      WHERE mail_id = ? AND batch = ? AND status = 'sending' ORDER BY id`,
    [mailId, batch],
  );
  if (rows.length === 0) return {};

  const messages = rows.map((r) => renderFor(snap, r));
  const idempotencyKey = rows[0].send_key;
  const input = { from: snap.from, subject: snap.mail.title, messages, idempotencyKey };

  let outcome: BatchOutcome = await provider.sendBatch(input);
  while (outcome.kind === "rate_limited") {
    const wait = Math.min(outcome.retryAfterMs, MAX_RATE_WAIT_MS);
    if (t.deadline !== undefined && t.now() + wait >= t.deadline) {
      await releaseBatch(mailId, batch);
      return { stop: "yield" };
    }
    await t.sleep(wait);
    outcome = await provider.sendBatch(input);
  }

  switch (outcome.kind) {
    case "sent": {
      const ids = outcome.ids;
      await markSent(mailId, rows.map((r, i) => [r.id, ids[i] ?? null]), t.now());
      return {};
    }
    case "invalid":
      return sendOneByOne(mailId, rows, messages, snap, idempotencyKey, provider, t.now);
    case "fatal":
      await releaseBatch(mailId, batch);
      return { stop: "fatal", message: outcome.message };
    case "in_progress":
      // Another worker holds this key right now; its outcome will land on these rows.
      return {};
    case "unknown":
      // Leave the rows claimed. Once the claim is stale they are retried under
      // the same key, which the provider deduplicates if this attempt landed.
      await run(`UPDATE deliveries SET error = ? WHERE mail_id = ? AND batch = ? AND status = 'sending'`, [
        outcome.message,
        mailId,
        batch,
      ]);
      return {};
  }
}

/**
 * The provider rejected the batch as a whole because of one message. Send the
 * messages singly so one bad address costs one row, not a hundred. When every
 * message fails the same way the problem isn't an address, so the send stops
 * and the rows go back to waiting.
 */
async function sendOneByOne(
  mailId: number,
  rows: { id: string }[],
  messages: BatchMessage[],
  snap: SendSnapshot,
  batchKey: string,
  provider: EmailProvider,
  now: () => number,
): Promise<BatchResult> {
  const results: ({ id: string } | { error: string })[] = [];
  for (let i = 0; i < rows.length; i++) {
    const m = messages[i];
    try {
      const r = await provider.sendEmail({
        from: snap.from,
        to: m.to,
        subject: snap.mail.title,
        html: m.html,
        headers: { "List-Unsubscribe": `<${m.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        idempotencyKey: `${batchKey}/${rows[i].id}`,
      });
      results.push({ id: r.id });
    } catch (e: any) {
      results.push({ error: e?.message || "send failed" });
    }
  }

  const errors = results.filter((r): r is { error: string } => "error" in r).map((r) => r.error);
  if (rows.length > 1 && errors.length === rows.length && errors.every((e) => e === errors[0])) {
    await run(`UPDATE deliveries SET status = 'pending', claimed_at = NULL, send_key = NULL, error = NULL WHERE id IN (${rows.map(() => "?").join(",")})`, rows.map((r) => r.id));
    return { stop: "fatal", message: errors[0] };
  }

  await markSent(
    mailId,
    rows.flatMap((r, i) => ("id" in results[i] ? [[r.id, (results[i] as { id: string }).id] as [string, string | null]] : [])),
    now(),
  );
  for (let i = 0; i < rows.length; i++) {
    const res = results[i];
    if ("error" in res) {
      await run(`UPDATE deliveries SET status = 'failed', error = ? WHERE id = ?`, [res.error, rows[i].id]);
    }
  }
  return {};
}

function renderFor(snap: SendSnapshot, r: { contact_id: string; email: string }): BatchMessage {
  // The contact id is a UUID, so the link is unguessable and unsubscribes only this person.
  const unsubscribeUrl = `${snap.origin}/api/unsubscribe?c=${r.contact_id}`;
  const html = renderEmailHtml(snap.mail as Mail, snap.design, snap.settings, {
    unsubscribeUrl,
    mobile: snap.mail.design_mobile,
  });
  return { to: r.email, html, unsubscribeUrl };
}

/** One statement for the whole batch: per-row UPDATEs would spend a subrequest per recipient. */
async function markSent(mailId: number, pairs: [string, string | null][], nowMs: number): Promise<void> {
  if (pairs.length === 0) return;
  const payload = JSON.stringify(pairs);
  await run(
    `UPDATE deliveries SET status = 'sent', sent_at = ?, error = NULL,
            provider_message_id = (SELECT json_extract(j.value, '$[1]') FROM json_each(?) j
                                    WHERE json_extract(j.value, '$[0]') = deliveries.id)
      WHERE mail_id = ? AND id IN (SELECT json_extract(value, '$[0]') FROM json_each(?))`,
    [iso(nowMs), payload, mailId, payload],
  );
}

/** Nothing was sent: hand the batch back so the next drain takes it fresh. */
async function releaseBatch(mailId: number, batch: number): Promise<void> {
  await run(
    `UPDATE deliveries SET status = 'pending', claimed_at = NULL, send_key = NULL, attempts = attempts - 1
      WHERE mail_id = ? AND batch = ? AND status = 'sending'`,
    [mailId, batch],
  );
}

async function finishIfDone(mailId: number, nowMs: number): Promise<SendProgress> {
  const p = await progress(mailId);
  if (p.status !== "sending" || p.open > 0) return p;
  // Only the first worker to see the send finished gets changes = 1; the rest are no-ops.
  await run(
    `UPDATE mails SET status = ?, sent_at = ?, scheduled_at = NULL, send_error = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'sending'`,
    [
      p.sent > 0 ? "sent" : "failed",
      iso(nowMs),
      p.sent > 0 ? null : p.failed > 0 ? "No recipient could be sent this issue." : "No confirmed subscribers were left to send to.",
      mailId,
    ],
  );
  return progress(mailId);
}

/** Where a send stands, from the rows themselves. */
export async function progress(mailId: number): Promise<SendProgress> {
  const mail = await get<{ status: string; send_error: string | null }>(
    `SELECT status, send_error FROM mails WHERE id = ?`,
    [mailId],
  );
  const counts = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM deliveries WHERE mail_id = ? GROUP BY status`,
    [mailId],
  );
  const n = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
  const status = mail?.status === "sent" || mail?.status === "failed" ? mail.status : "sending";
  return {
    status,
    sent: n("sent"),
    failed: n("failed"),
    skipped: n("skipped"),
    open: n("pending") + n("sending"),
    error: mail?.send_error ?? null,
  };
}
